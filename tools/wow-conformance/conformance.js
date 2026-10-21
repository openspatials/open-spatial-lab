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

// The first graph of every world server. A graph id is an integer, as the API types it.
const GRAPH_ID = 1;

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

    // Spatial composition graph. Since iteration 1 OSL serves the canonical shapes by default: the
    // `Spatial` resource at /wow/spatial/{spatialID} and the canonical `Node` (children embedded) at
    // /node/{nodeId}. Graph id 1 is the first graph of every world server, an integer as the API
    // types it. OSL's flat node (`OSLFlatNode`, children are integer ids) is served only on an
    // explicit request, `?nodeForm=flat`; it is the labeled extension that remains of D1.
    { id: 'spatial.root', method: 'GET', path: '/wow/spatial/1', kind: 'spatial',
        responseSchema: 'Spatial', canonicalSchema: 'Spatial', live: true,
        fixture: fx.spatialDescriptor },
    { id: 'spatial.node', method: 'GET', path: '/wow/spatial/1/node/0', kind: 'node',
        responseSchema: 'Node', canonicalSchema: 'Node', live: true,
        fixture: fx.canonicalNode },
    { id: 'spatial.node.flat', method: 'GET', path: '/wow/spatial/1/node/0?nodeForm=flat', kind: 'flatNode',
        responseSchema: 'OSLFlatNode', canonicalSchema: 'Node', live: true,
        fixture: fx.graphRootNode },
    // A write. The gate sends it only to a server it started itself (opts.allowWrites), never to a
    // server it was handed, so a run cannot change someone else's graph.
    { id: 'spatial.node.create', method: 'POST', path: '/wow/spatial/1/node/1', kind: 'node',
        requestSchema: 'Node[]', canonicalSchema: 'Node', requestBody: true, writes: true,
        fixture: fx.nodeCreateBody },

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
    // The Spatial resource is the canonical object plus the same labeled bag the other resources carry.
    if (kind === 'spatial') { declaredExt.add('webofworlds_extension'); declaredExt.add('proof_boundary'); }
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

    // geoPose longitude. The contract (the iteration 1 overlay, a proposed upstream edit) spells
    // it `lon`, as the OGC GeoPose schema does; the World API at d39a1a0 spells it `lan`. That
    // difference is declared as D9. `lan` is deprecated and a server never emits it.
    const gp = payload.geoPose && payload.geoPose.position;
    if (gp && typeof gp === 'object') {
        const hasLon = Object.prototype.hasOwnProperty.call(gp, 'lon');
        const hasLan = Object.prototype.hasOwnProperty.call(gp, 'lan');
        if (hasLon && !hasLan)
            out.push({ level: 'divergence',
                msg: 'geoPose.position spells longitude `lon` — a DECLARED divergence (D9): the OSL overlay, a '
                    + 'proposed upstream edit; the World API at d39a1a0 spells it `lan`. Not drift.' });
        else if (hasLan)
            out.push({ level: 'drift',
                msg: 'geoPose.position carries the deprecated `lan`' + (hasLon ? ' beside `lon`' : '')
                    + ' — OSL serves `lon` only' });
    }

    if (kind === 'node' || kind === 'flatNode') {
        // The standard (WoWAPI@d39a1a0, API.yaml:484-487) types children as EMBEDDED Node objects.
        // OSL serves exactly that by default. Integer id references are OSL's flat form, served only
        // on an explicit request (`?nodeForm=flat`): the labeled extension that remains of D1.
        //   kind 'node'     : the default form. Integer ids here mean the server answered the default
        //                     request in the flat form, which is drift.
        //   kind 'flatNode' : the form that was asked for by name. Integer ids are the declared
        //                     divergence; embedded objects here mean the server ignored the request.
        // Children that mix the two conform to neither.
        if (Array.isArray(payload.children) && payload.children.length) {
            const nonInt = payload.children.filter(c => !Number.isInteger(c));
            const allIds = nonInt.length === 0;
            const noIds = nonInt.length === payload.children.length;
            if (!allIds && !noIds)
                out.push({ level: 'drift',
                    msg: 'Node.children MIXES integer id refs and embedded objects — conforms to '
                        + 'NEITHER the standard NOR the OSLFlatNode form' });
            else if (kind === 'node' && noIds)
                out.push({ level: 'note',
                    msg: 'Node.children EMBEDS child objects — CONFORMANT-TO-STANDARD (canonical Node), '
                        + 'the default form since iteration 1.' });
            else if (kind === 'node' && allIds)
                out.push({ level: 'drift',
                    msg: 'Node.children are integer id references on a DEFAULT request — the canonical Node '
                        + 'embeds child objects. OSL serves id references only on an explicit flat request.' });
            else if (kind === 'flatNode' && allIds)
                out.push({ level: 'divergence',
                    msg: 'Node.children uses INTEGER id references — OSL\'s LABELED flat form (OSLFlatNode), '
                        + 'served only on explicit request (D1, narrowed). The OpenSpatialWorld standard EMBEDS '
                        + 'child Node objects (items: $ref Node). Not drift: declared.' });
            else
                out.push({ level: 'drift',
                    msg: 'Node.children EMBEDS child objects although the flat form was requested' });
        }
        if (Array.isArray(payload.localTransform)) {
            // The standard constrains neither the length nor the major order of localTransform
            // (items: number, that is all). Iteration 1 constrains both (D9): column-major, 16 numbers.
            if (payload.localTransform.length !== 16)
                out.push({ level: 'divergence',
                    msg: 'Node.localTransform is not 16 numbers (found length '
                        + payload.localTransform.length + '). The standard allows any length; OSL requires 16 '
                        + '(column-major 4x4) — the iteration 1 overlay, declared as D9.' });
            else if (!payload.localTransform.every(n => typeof n === 'number'))
                out.push({ level: 'drift', msg: 'Node.localTransform contains non-number entries '
                    + '(the standard types the items `number`)' });
        }
    }
    if (kind === 'spatial') {
        // D4 retired: the graph id is an integer, as the API types it.
        if (!Number.isInteger(payload.id))
            out.push({ level: 'drift', msg: 'Spatial.id is not an integer (' + JSON.stringify(payload.id)
                + ') — the API types a graph id as integer' });
        if (!Number.isInteger(payload.rootNodeID))
            out.push({ level: 'drift', msg: 'Spatial.rootNodeID is not an integer' });
    }
    return out;
}

// The divergences OSL DECLARES against the OpenSpatialWorld standard, with the
// upstream line references. Emitted into the evidence so a reader can never
// mistake OSL's shape for the standard's.
const DECLARED_DIVERGENCES = [
    // Iteration 1 retired D1, D3, D4 and D7, and D2 with them. A retired entry keeps its id and says
    // what replaced it. D1 and D7 leave one labeled extension behind: the flat node form on request.
    { id: 'D1', subject: 'Node.children', upstream: 'API.yaml:484-487 (items: $ref Node)',
        standard: 'children are EMBEDDED child Node objects',
        osl: 'RETIRED as the default. A node read or written without a form is the canonical Node, children embedded. '
            + 'One labeled extension remains: OSL\'s flat form (OSLFlatNode, children are integer node ids) is served and '
            + 'accepted only on explicit request (`X-OSL-WoW-Node-Form: flat` or `?nodeForm=flat`).',
        schema: 'OSLFlatNode', status: 'RETIRED in iteration 1 — the flat form remains as a labeled extension on request' },
    { id: 'D2', subject: 'Spatial schema', upstream: 'API.yaml:438-468',
        standard: 'a graph DESCRIPTOR {id, rootNodeID, geoPose}',
        osl: 'RETIRED. The descriptor is served by default, with integer ids. The opt-in it needed (`?form=descriptor`, '
            + '`X-OSL-WoW-Spatial-Form`) is gone; `?form=node` returns the root node, an OSL convenience.',
        schema: 'Spatial', status: 'RETIRED in iteration 1' },
    { id: 'D3', subject: 'GET /wow/spatial/{spatialID} response', upstream: 'API.yaml:133-153 (getSpatialById)',
        standard: 'returns a Spatial descriptor (points AT a root node)',
        osl: 'RETIRED. It returns the Spatial descriptor by default. The root node stays at /node/{rootNodeID}.',
        schema: 'Spatial', status: 'RETIRED in iteration 1' },
    { id: 'D4', subject: 'spatialID path param', upstream: 'API.yaml:141-146 (type: integer)',
        standard: 'integer', osl: 'RETIRED. The graph id is an integer. The server still resolves four legacy string '
            + 'aliases (the world id, the location id, `default`, `world`) for compatibility; the contract does not list them.',
        schema: null, status: 'RETIRED in iteration 1 — legacy string aliases still resolve, outside the contract' },
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
        osl: 'RETIRED. A canonical POST with embedded children is stored by default, and the response lists the nodes '
            + 'created at the top level. A body in the flat form is accepted only on explicit request. The 400 and 422 '
            + 'refusal codes (`payload_too_large`, `invalid_parent`, `child_restructure_not_supported` and others) are '
            + 'OSL extensions: the standard specifies none of them.',
        schema: 'Node',
        status: 'RETIRED in iteration 1 — the refusal codes remain OSL extensions' },
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
    // The iteration 1 overlay: behaviour OSL serves that the standard at d39a1a0 does not state.
    { id: 'D9', subject: 'iteration 1 overlay (proposed upstream edits)',
        upstream: 'API.yaml:294,368,395,424,456 (lan); 488-491 (localTransform); 482-487 (parent, children)',
        standard: 'spells longitude `lan`; types `localTransform` as an array of numbers of any length; says nothing '
            + 'about whether `children` can be written, how a node moves, or whether a node id can be reused',
        osl: 'spells longitude `lon` (`lan` is read as deprecated and never emitted); refuses a `localTransform` that is not '
            + '16 numbers with a last row of 0,0,0,1, or that has shear or zero scale; derives `children` from the tree '
            + '(a PUT that changes them is 422); moves a node by a PUT of `parent`; never reuses a node id within a world',
        schema: 'GeoPose',
        status: 'DECLARED OVERLAY — each item is a proposed upstream edit, proven by `npm run arch-i1-proof`; '
            + 'standards_conformance stays false' },
];

// Honesty guard: /wow read responses MUST carry proof_boundary with
// standards_conformance:false (no cosmetic green). Returns { ok, problems[] }.
function honestyCheck(kind, payload)
{
    const problems = [];
    if (kind === 'events' || kind === 'node' || kind === 'flatNode') return { ok: true, problems };
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
            } else if (ep.writes && !opts.allowWrites) {
                // A write is never sent to a server this gate did not start.
                r.live = { attempted: false, http_status: null };
                r.status = 'contract-only';
                r.reason = 'write not driven: this run was handed a running server, and the gate does not '
                    + 'write to a server it did not start. The fixture validates the request body against the contract.';
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
                        ? 'live 404 — contract-only: the fixture validates the contract shape, the server does not serve it yet'
                        : 'live 404 — endpoint expected live but not served';
                    if (!ep.contractOnly) problems.push(ep.id + ' live: expected-live endpoint returned 404');
                } else if (ep.writes && (resp.status === 200 || resp.status === 201)) {
                    // The nodes the server created, top level, in the canonical form.
                    const res = validator.validateRequest('Node[]', resp.json);
                    const created = Array.isArray(resp.json) ? resp.json : [];
                    const createdDrift = created.flatMap(n => driftCheck('node', n).filter(d => d.level === 'drift').map(d => d.msg));
                    r.live.response_valid = res.valid;
                    r.live.served_schema = 'Node[]';
                    r.live.response_errors = res.valid ? null : res.errorsText;
                    r.live.created = created.length;
                    r.drift = createdDrift;
                    if (!res.valid) { r.status = 'fail'; r.reason = 'created nodes fail Node[]: ' + res.errorsText;
                        problems.push(ep.id + ' live: created nodes fail Node[]: ' + res.errorsText); }
                    else if (createdDrift.length) { r.status = 'fail'; r.reason = 'drift on created nodes: ' + createdDrift.join('; ');
                        for (const d of createdDrift) problems.push(ep.id + ' live: drift — ' + d); }
                    else if (!created.length) { r.status = 'fail'; r.reason = 'the write created no nodes';
                        problems.push(ep.id + ' live: the write created no nodes'); }
                    else { r.status = 'conformant'; r.reason = created.length + ' node(s) created; the response is valid vs the canonical Node[]'; }
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
                    else if (ep.kind === 'flatNode' && !canon.valid) {
                        // A flat leaf can satisfy both shapes; a flat node whose canonical check fails for
                        // another reason is not a plain pass.
                        r.status = 'conformant-with-declared-divergence';
                        r.reason = 'response valid vs OSLFlatNode (LABELED, non-canonical); canonical Node valid: false';
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
    // LIVE-only (a fixtures-only run skips this whole block). Walk the real graph the way a client
    // does: read the Spatial resource of graph 1, read the root node it points at, walk the embedded
    // children, fetch every node by its own URL, and validate each portal node (found by
    // role==='portal' or the labeled osl-portal: URI). Everything is validated against the canonical
    // `Node`, which is what OSL serves by default since iteration 1. The labeled flat form is
    // probed separately by the `spatial.node.flat` endpoint above.
    if (baseUrl) {
        const nodeKeySet = propKeys(doc, 'Node');
        const spPath = '/wow/spatial/' + GRAPH_ID;
        const rootRec = {
            id: 'spatial.live.root', method: 'GET', path: spPath + '/node/{rootNodeID}', kind: 'node',
            declared: 'live', tracked_by: 'runtime/runtime', fixture: null,
            live: { attempted: true, http_status: null }, drift: [], divergences: [], notes: [],
            canonical_fields_present: [], extensions_in_use: [], undeclared_fields: [], wow_extension: null,
            status: null, reason: null,
        };
        endpoints.push(rootRec);
        const spatialResp = await httpRequestJson(baseUrl, 'GET', spPath);
        const rootNodeID = spatialResp.json && spatialResp.json.rootNodeID;
        if (spatialResp.status !== 200 || !Number.isInteger(rootNodeID)) {
            rootRec.status = 'error';
            rootRec.reason = 'could not read the Spatial resource of graph ' + GRAPH_ID + ' (HTTP ' + spatialResp.status + ')';
            problems.push('spatial.live.root: ' + rootRec.reason);
        } else {
            rootRec.path = spPath + '/node/' + rootNodeID;
            const rootResp = await httpRequestJson(baseUrl, 'GET', rootRec.path);
            rootRec.live.http_status = rootResp.status || null;
            if (rootResp.status !== 200 || !rootResp.json) {
                rootRec.status = 'fail';
                rootRec.reason = 'root node ' + rootRec.path + ' not 200 (' + rootResp.status + ')';
                problems.push('spatial.live.root: ' + rootRec.path + ' returned ' + rootResp.status);
            } else {
                const sv = validator.validateResponse('node', rootResp.json);
                const all = driftCheck('node', rootResp.json);
                const drift = all.filter(d => d.level === 'drift').map(d => d.msg);
                rootRec.drift = drift;
                rootRec.divergences = all.filter(d => d.level === 'divergence').map(d => d.msg);
                rootRec.notes = all.filter(d => d.level === 'note').map(d => d.msg);
                rootRec.live.served_schema = 'Node';
                rootRec.live.served_valid = sv.valid;
                rootRec.live.canonical_schema = 'Node';
                rootRec.live.canonical_node_valid = sv.valid;
                rootRec.live.canonical_node_errors = sv.valid ? null : sv.errorsText;
                rootRec.canonical_fields_present = Object.keys(rootResp.json).filter(k => nodeKeySet.has(k));
                if (!sv.valid) { rootRec.status = 'fail'; rootRec.reason = 'root fails the canonical Node: ' + sv.errorsText;
                    problems.push('spatial.live.root: ' + sv.errorsText); }
                else if (drift.length) { rootRec.status = 'fail'; rootRec.reason = 'drift: ' + drift.join('; ');
                    for (const d of drift) problems.push('spatial.live.root: drift — ' + d); }
                else { rootRec.status = 'conformant'; rootRec.reason = 'root node valid vs the canonical Node, children embedded'; }

                // The tree, walked without recursion. A node that appears twice is a defect in the tree.
                const tree = [];
                const seen = new Set();
                const stack = [ rootResp.json ];
                let duplicateIds = 0;
                while (stack.length && tree.length < 20000) {
                    const node = stack.pop();
                    if (seen.has(node.id)) { duplicateIds += 1; continue; }
                    seen.add(node.id);
                    tree.push(node);
                    for (const child of Array.isArray(node.children) ? node.children : [])
                        if (child && typeof child === 'object') stack.push(child);
                }
                if (duplicateIds) problems.push('spatial.live.root: ' + duplicateIds + ' node id(s) appear more than once in the tree');

                // N5 on the wire: every node URL resolves.
                let fetched = 0;
                const failed = [];
                let portalCount = 0;
                for (const embedded of tree) {
                    if (embedded.id === rootNodeID) continue;
                    const nr = await httpRequestJson(baseUrl, 'GET', spPath + '/node/' + encodeURIComponent(embedded.id));
                    if (nr.status !== 200 || !nr.json || nr.json.id !== embedded.id) {
                        failed.push({ id: embedded.id, http_status: nr.status ?? null,
                            reason: nr.status !== 200 ? ('HTTP ' + (nr.status ?? 'no-response')) : 'unparseable or mismatched body' });
                        problems.push('spatial.live.node.' + embedded.id + ': node fetch FAILED ('
                            + (nr.status !== 200 ? ('HTTP ' + (nr.status ?? 'no-response')) : 'unparseable or mismatched body')
                            + ') — the composition graph was only PARTIALLY walked; this diagnostics does not cover node ' + embedded.id);
                        continue;
                    }
                    fetched++;
                    const node = nr.json;
                    const ext = node.webofworlds_extension || {};
                    const isPortal = ext.role === 'portal' || /^osl-portal:/.test(node.spatialAssetURI || '');
                    if (!isPortal) continue;
                    portalCount += 1;
                    const pv = validator.validateResponse('node', node);
                    const pall = driftCheck('node', node);
                    const pdrift = pall.filter(d => d.level === 'drift').map(d => d.msg);
                    const resolvable = typeof ext.target_spatial_graph_endpoint === 'string' && ext.target_spatial_graph_endpoint.length > 0;
                    const rec = {
                        id: 'spatial.live.portal.node.' + embedded.id, method: 'GET', path: spPath + '/node/' + embedded.id, kind: 'node',
                        declared: 'live', tracked_by: 'runtime', fixture: null,
                        live: { attempted: true, http_status: nr.status, portal_id: ext.portal_id || null,
                            served_schema: 'Node', served_valid: pv.valid,
                            canonical_schema: 'Node', canonical_node_valid: pv.valid,
                            canonical_node_errors: pv.valid ? null : pv.errorsText,
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
                    if (!pv.valid) { rec.status = 'fail'; rec.reason = 'portal node fails the canonical Node: ' + pv.errorsText;
                        problems.push(rec.id + ': ' + pv.errorsText); }
                    else if (pdrift.length) { rec.status = 'fail'; rec.reason = 'drift: ' + pdrift.join('; ');
                        for (const d of pdrift) problems.push(rec.id + ': drift — ' + d); }
                    else if (!resolvable) { rec.status = 'fail';
                        rec.reason = 'portal node destination NOT resolvable (no target_spatial_graph_endpoint)';
                        problems.push(rec.id + ': destination not resolvable'); }
                    else {
                        rec.status = 'conformant';
                        rec.reason = 'portal node valid vs the canonical Node + resolvable destination (labeled, surfaced)';
                    }
                    endpoints.push(rec);
                }
                // The walk's COVERAGE is part of the evidence, not an implicit assumption.
                rootRec.graph_walk = {
                    nodes_in_tree: tree.length,
                    nodes_fetched_by_url: fetched,
                    nodes_failed: failed.length,
                    failures: failed,
                    complete: failed.length === 0 && duplicateIds === 0,
                };
                rootRec.reason += portalCount
                    ? '; ' + portalCount + ' portal node(s) validated live'
                    : '; WARNING: no portal nodes found in graph';
                if (failed.length) {
                    rootRec.status = 'fail';
                    rootRec.reason += '; PARTIAL WALK: ' + failed.length + ' of ' + (tree.length - 1)
                        + ' node(s) below the root could NOT be fetched — this record does not describe the whole graph';
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
    // ---- THE UN-INVERSION, kept ----
    // Until 2026-07-11 this block certified REJECTING the standard as conformance. The canonical
    // `Node` EMBEDS child Node objects (API.yaml:484-487). Since iteration 1 OSL serves that shape by
    // default, and the flat form only on request. These checks pin each shape to the right schema.
    selfCheck('canonical Node ACCEPTS embedded child objects (THE STANDARD — was inverted)',
        validator.validateCanonical('node', fx.canonicalNode()).valid === true,
        validator.validateCanonical('node', fx.canonicalNode()).errorsText);
    selfCheck('canonical Node REJECTS integer id-ref children (proves `Node` is the STANDARD, not the flat form)',
        validator.validateCanonical('node', fx.graphRootNode()).valid === false);
    selfCheck('the DEFAULT node form accepts embedded children and rejects id refs',
        validator.validateResponse('node', fx.canonicalNode()).valid === true
        && validator.validateResponse('node', fx.graphRootNode()).valid === false);
    selfCheck('OSLFlatNode ACCEPTS the flat id-ref node OSL serves on explicit request',
        validator.validateResponse('flatNode', fx.graphRootNode()).valid === true,
        validator.validateResponse('flatNode', fx.graphRootNode()).errorsText);
    selfCheck('OSLFlatNode REJECTS embedded child objects (the flat form is enforced on its own shape)',
        validator.validateResponse('flatNode', fx.canonicalNode()).valid === false);
    selfCheck('Spatial ACCEPTS {id, rootNodeID, geoPose} with an integer id',
        validator.validateResponse('spatial', fx.spatialDescriptor()).valid === true,
        validator.validateResponse('spatial', fx.spatialDescriptor()).errorsText);
    selfCheck('Spatial REJECTS a string graph id (D4 retired: the graph id is an integer)',
        validator.validateResponse('spatial', Object.assign(fx.spatialDescriptor(), { id: 'world' })).valid === false);
    selfCheck('Node REJECTS a localTransform that is not 16 numbers (iteration 1 overlay, D9)',
        validator.validateResponse('node', fx.badNodes().shortTransform).valid === false);

    // ajv catches structural breaks, under BOTH schemas
    selfCheck('ajv rejects a node with wrong types (canonical Node)',
        validator.validateRequest('Node', fx.badNodes().wrongTypes).valid === false);
    selfCheck('ajv rejects a node with wrong types (OSLFlatNode)',
        validator.validateRequest('OSLFlatNode', fx.badNodes().wrongTypes).valid === false);
    selfCheck('ajv rejects children MIXING id refs and embedded objects (conforms to NEITHER shape)',
        validator.validateCanonical('node', fx.badNodes().mixedChildren).valid === false
        && validator.validateResponse('node', fx.badNodes().mixedChildren).valid === false);

    // drift guard: it must name the STANDARD correctly in BOTH directions
    selfCheck('drift guard reports embedded children on a DEFAULT node as CONFORMANT-TO-STANDARD (a note, never drift)',
        driftCheck('node', fx.canonicalNode()).some(d => d.level === 'note')
        && !driftCheck('node', fx.canonicalNode()).some(d => d.level === 'drift'));
    selfCheck('drift guard flags integer id children on a DEFAULT node as drift (the flat form is only served on request)',
        driftCheck('node', fx.graphRootNode()).some(d => d.level === 'drift'));
    selfCheck('drift guard reports id-ref children on an explicit FLAT node as the labeled divergence (never as the standard)',
        driftCheck('flatNode', fx.graphRootNode()).some(d => d.level === 'divergence')
        && !driftCheck('flatNode', fx.graphRootNode()).some(d => d.level === 'drift'));
    selfCheck('drift guard flags embedded children on an explicit FLAT node (the server ignored the request)',
        driftCheck('flatNode', fx.canonicalNode()).some(d => d.level === 'drift'));
    selfCheck('drift guard catches MIXED children as real drift, in both forms',
        driftCheck('node', fx.badNodes().mixedChildren).some(d => d.level === 'drift')
        && driftCheck('flatNode', fx.badNodes().mixedChildren).some(d => d.level === 'drift'));
    selfCheck('drift guard catches a non-integer Spatial id',
        driftCheck('spatial', Object.assign(fx.spatialDescriptor(), { id: 'world' })).some(d => d.level === 'drift')
        && !driftCheck('spatial', fx.spatialDescriptor()).some(d => d.level === 'drift'));
    // drift guard catches what ajv (open schemas) does not
    selfCheck('drift guard flags a non-16 localTransform (the iteration 1 overlay, reported as the divergence D9)',
        driftCheck('flatNode', fx.badNodes().shortTransform)
            .some(d => d.level === 'divergence' && /localTransform/.test(d.msg) && /D9/.test(d.msg)));
    selfCheck('drift guard catches the deprecated lan',
        driftCheck('world', fx.worldWithLanDrift()).some(d => d.level === 'drift'));
    selfCheck('drift guard reports lon as the declared divergence D9, never as drift',
        driftCheck('world', fx.worldResponse()).some(d => d.level === 'divergence' && /D9/.test(d.msg))
        && !driftCheck('world', fx.worldResponse()).some(d => d.level === 'drift'));
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
    const writesNotDriven = endpoints.filter(e => e.live && e.live.attempted === false);
    const notCovered = liveDriven ? liveShortfall.map(s =>
        'LIVE ' + s.method + ' ' + s.path + ' — ' + s.why).concat(writesNotDriven.map(e =>
        'LIVE ' + e.method + ' ' + e.path + ' — write not driven: ' + e.reason)) : [
        'LIVE HTTP pass: no WoW endpoint was driven against a running server. Every '
            + 'endpoint below is a CONTRACT/FIXTURE result only — it proves the fixture matches '
            + 'the schema, NOT that the server emits it.',
        'LIVE honesty guard: no on-the-wire response was checked for '
            + 'proof_boundary.standards_conformance:false. A cosmetic green on the real server '
            + 'would NOT have been caught by this run.',
        'LIVE composition-graph portal battery: the /wow/spatial graph walk, the portal '
            + 'node role/URI surfacing, and the resolvable-destination assertion did not run.',
        'LIVE canonical Node observation: no served node payload was compared against the canonical '
            + 'Node schema in this run.',
        'LIVE X-OSL-WoW-Validation header parity (server-side validator observability).',
        'WS /events upgrade probe.',
    ];

    return {
        captured_at: new Date().toISOString(),
        mode: liveDriven ? 'fixtures+live' : 'fixtures-only',
        coverage: {
            live_driven: liveDriven,
            complete: liveDriven && liveShortfall.length === 0 && writesNotDriven.length === 0,
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
            'Since iteration 1 the /wow/spatial/* payloads are the canonical shapes by default: the `Spatial` '
                + 'resource at /wow/spatial/{spatialID} and the canonical `Node`, children embedded, at /node/{nodeId}. '
                + 'This run validated them against the contract that OSL itself maintains, which carries the iteration 1 '
                + 'overlay (D9): a node\'s localTransform is 16 numbers, longitude is `lon`. Those are proposed upstream '
                + 'edits, not yet part of the upstream standard, so a pass here is NOT a claim of standards conformance. '
                + (liveDriven
                    ? 'The flat node form (OSLFlatNode) was probed on explicit request and reports canonical_core_valid:false where it has children.'
                    : 'THIS RUN DROVE NO LIVE SPATIAL RECORDS, so it made no observation of what the server serves.'),
            'The flat node form is OSL\'s labeled extension (D1, narrowed). It is served only on explicit request '
                + '(`X-OSL-WoW-Node-Form: flat` or `?nodeForm=flat`). The standard specifies neither.',
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
