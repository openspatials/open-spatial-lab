'use strict';

/*
 * Lane 3 standalone backend node server.
 *
 * Zero external dependencies: uses only Node core `http` + a tiny hand-rolled
 * WebSocket (RFC6455) server for `/runtime-state`, so the prototype vendors
 * nothing and runs on plain `node`. (Vendoring policy satisfied by having no
 * third-party deps at all.)
 *
 * Serves (BackendContract.serves):
 *   GET  /wow/world              (WoW OpenAPI `World` schema shape)
 *   GET  /wow/location           (stable backend location/resource contract)
 *   GET  /wow/graph              (configured authored WoW graph, when present)
 *   GET  /wow/portal/{portalId}  (integer id per WoW OpenAPI -> strict `Portal`
 *                                 shape; legacy string portal_id kept as a
 *                                 labeled compatibility alias)
 *   GET  /wow/user/{userId}      (integer id 1 per WoW OpenAPI -> strict `User`
 *                                 shape; aliases me/avatar_id/continuity_id)
 *   GET /wow/view/{viewId} (the PlayerView camera as a
 *                                 WoW `View`; id 1, alias 'player')
 *   GET  /debug/state
 *   GET  /runtime-state         (WS upgrade; full-state broadcast)
 *   GET /events (WS upgrade; — TYPED,
 *                                GRANULAR realtime events: user_joined/left +
 *                                node_created/updated/deleted. LABELED
 *                                NON-CANONICAL reference-impl convention, NOT
 *                                part of the OpenSpatialWorld read spec.)
 *   GET  /.well-known/spatial-fabric   (fabric discovery, TeleportXR-native shape)
 *   GET  /fabric.json           (OMB fabric manifest — plain-JSON, unsigned,
 *                                labeled. Never call the
 *                                format "MSF": that means Metaverse Standards
 *                                Forum only in this project.)
 *   GET  /healthz
 *   GET /demo/scene-objects (DEMO EXTENSION — hosted
 *                                   primitives; labeled, NOT a spec route)
 *   GET /demo/um/attach-point (THE reloadable hosted point — the
 *                                   portal-view value; clients RE-READ it, the
 *                                   server never streams it; labeled demo
 *                                   interpretation, NOT UM/IWPS conformance)
 *   GET  /demo/portal-view?resolution=color|snapshot3d|splats
 *   GET  /fabric/region?anchor_portal_id=&radius_m=
 *                                  (portal-neighborhood
 *                                   partial fabric read — entities near the
 *                                   anchor portal + occupancy + totals;
 *                                   labeled local proof, read-only)
 *   GET /fabric/presence (light occupancy
 *                                   summary for prefetch refresh polling)
 * Accepts (BackendContract.accepts):
 *   POST /portal/exit-intent
 *   POST /portal/arrival
 *   POST /movement            (state-ownership proof helper)
 *   POST /reset               (reset/replay)
 *   POST /demo/scene-objects/move
 *   POST /demo/portal/move
 *
 * CLAIM BOUNDARY: local server truth only. Every /wow response carries the four
 * proof-boundary flags. No native teleport, first-party render, reliability,
 * security, persistence, or conformance is claimed.
 */

const http = require('http');
const crypto = require('crypto');
const { createRuntime } = require('./runtime-state');
const { createMirrors } = require('./mirrors');
const { makeConfig } = require('./config');
// the RENDERABLE authored scene that closes the publish
// loop. getFabricManifest()'s live world-root (spawn+portal+trigger) VERIFIES
// but draws nothing through the Filament compositor; this builds a NEW fabric
// whose data.scene is a genuinely drawable CELESTIAL scene (star + orbiting
// planet). Signed by the SAME signer, served by the SAME dedicated CORS sender.
// the OpenSpatialAsset pillar (content negotiation + ETag /
// conditional-GET / 304 over REAL assets) and the OpenUserManifest ORIGIN (HEAD /
// ETag / 302 / 403 / 404, a genuinely separate web origin — RFC 6454 scheme+host+
// PORT). Additive, vanilla-Node; no Express, no graph-store rewrite.
const wowAsset = require('./wow-asset');
const wowMediaTypes = require('./wow-media-types');
// always-on, contract-driven request/response
// enforcement, derived from wow-spec's own `paths`. No env gate exists.
const { createContractEnforcer } = require('./wow-contract-enforcer');
// the PURE structural classifier for incoming node bodies.
// It is what produces `embedded_children_not_supported` (+ machine-readable
// remedies) instead of a bare schema error, and CONF-1 keeps that richer refusal
// reachable now that ajv runs on every request.
const { inspectIncomingForest, inspectIncomingTransforms } = require('./spatial-graph');

// the local fresh-slate operator refuses old or mixed
// backend builds before its first mutation. Increment this only when the
// synchronous /reset snapshot contract below changes incompatibly.
const FRESH_DEMO_RESET_CONTRACT_VERSION = 1;

// signed-fabric material lives OUTSIDE the handler
// (the handler shadows `path` with url.pathname, so file paths are precomputed
// here with nodePath). The OSL dev CA is a labeled DEV/TEST trust anchor, not
// public PKI (see secrets/osl-dev-ca/LABEL.txt).


function createServer(role, extraOpts)
{
    const cfg = makeConfig(role, extraOpts);
    const runtime = createRuntime(cfg);
    // Nodes that mirror another world's data point are kept up to date by observing it (iteration 3).
    const mirrors = cfg.mirrors === false ? null : createMirrors(runtime, { token : cfg.mirror_token });

    /*
     * WHERE the node binds vs WHAT the fixture declares.
     *
     * cfg.http_port is the node's DECLARED, deterministic PRD fixture port
     * (location-a: 18151, location-b: 18152, lobby: 18153). That is a contract,
     * and the acceptance harness asserts it (T-L1) — it must not drift.
     *
     * cfg.bind_port is an OPERATIONAL override for the socket only. It exists so
     * test/proof harnesses can listen on ISOLATED ports and never squat the
     * local demo (8143 / 18151-18153), without touching the fixture
     * contract they are proving. Unset (every production caller) => bind_port ===
     * http_port and behaviour is byte-identical to before.
     */
    const bindPort = Number(cfg.bind_port) || cfg.http_port;

    // ---- ALWAYS-ON, CONTRACT-DRIVEN validation --
    //
    // Supersedes the env-gated layer. Two things changed here and
    // nothing else:
    //
    //   1. ALWAYS ON. `OSL_WOW_VALIDATE` is no longer read anywhere in this lane.
    //      There is no env var, flag or launcher switch that can serve the /wow
    //      surface unenforced. Enforcement is FAIL-CLOSED: if the contract cannot
    //      be loaded, or declares no /wow operations, createContractEnforcer()
    //      THROWS and this server does not start. (Launchers may still export
    //      OSL_WOW_VALIDATE — it is inert.)
    //
    //   2. CONTRACT-DRIVEN. WHICH schema an endpoint carries is derived at
    //      startup from the contract's own `paths` (wow-spec/generated/schema.json
    //      <- wow-spec/schema.yaml). The wrappers that used to sit at each call
    //      site — wowValidate(res, 'world', ...), wowValidateNodeResponse(...),
    //      wowValidateNodeRequest('OSLFlatNode') — WERE a hand-maintained parallel
    //      list of endpoint->schema pairs, and drift between that list and the
    //      contract is the defect CONF-1 closes. They are gone: the
    //      handlers below now just call sendJson(), and the verdict is computed
    //      from the contract.
    //
    // Reuse-over-rebuild mandate is intact: this is
    // still an ADDITIVE layer inside the vanilla-Node server, NOT Express and NOT
    // express-openapi-validator. literal "migrate to Express" is declined
    // because the mandate names this backend directly.
    //
    // Unchanged, deliberately: RESPONSE validation NEVER alters the JSON body or
    // the HTTP status (honesty — conformance is surfaced, never silently
    // "fixed"); it only adds X-OSL-WoW-Validation, in the same `pass:<schema>` /
    // `fail:<schema>` / `error` vocabulary as before. REQUEST validation still
    // lets the write handlers refuse an invalid body with the contract's 400/422.
    const wowContract = createContractEnforcer(
        // OPERATIONAL override for proof harnesses ONLY — the same precedent as
        // cfg.bind_port above. It drives the enforcer from an alternate contract
        // document so a harness can prove enforcement FOLLOWS the contract. Unset
        // for every production caller, and it cannot DISABLE enforcement: a
        // document with no /wow operations throws.
        cfg.wow_contract_doc ? { doc : cfg.wow_contract_doc } : undefined);

    // The declared content variants are read back off headers the handler has
    // ALREADY emitted (X-OSL-WoW-Spatial-Form, X-OSL-WoW-Node-Form), so there is no second place where
    // a variant has to be remembered.
    function wowResponseCtx(res)
    {
        let spatialForm = null;
        let nodeForm = null;
        try { spatialForm = String(res.getHeader('X-OSL-WoW-Spatial-Form') || '') || null; } catch (e) {}
        try { nodeForm = String(res.getHeader('X-OSL-WoW-Node-Form') || '') || null; } catch (e) {}
        return { spatialForm, nodeForm };
    }

    // The form a request wants a node in: the canonical Node (children embedded) by default, or the
    // labeled OSLFlatNode (children are ids) when it says `flat`. `canonical` is accepted as the default.
    function requestedNodeForm(req, url)
    {
        const raw = String(req.headers['x-osl-wow-node-form'] || url.searchParams.get('nodeForm') || '').toLowerCase();
        return raw === 'flat' ? 'flat' : 'canonical';
    }

    // ---- Web of Worlds resources over HTTP (iteration 2) -------------------------------------------
    //
    // MEDIA TYPE. A World, User, View, Portal, Spatial or Node is served as `application/wow+json`, so a
    // client that finds the address in a node's `spatialAssetURI` can tell another world's content from
    // a model by the answer's Content-Type alone. `application/json` stays available: a request that
    // prefers it (Accept: application/json) gets it. The name is a working name, provisional until the
    // Web of Worlds group decides it. Error bodies stay `application/json`: they are not resources.
    //
    // ENTITY TAGS. GET /wow/world, GET /wow/spatial/{id} and the node GET carry ETag and Last-Modified
    // and answer If-None-Match with 304. The node PUT and DELETE honor If-Match and answer 412 when it
    // does not match the node's current representation (RFC 9110 §13.1). A tag is a hash of the bytes
    // served with their media type, so each representation of a resource has its own tag.
    //
    // CROSS-ORIGIN READS. Every /wow/ response carries Access-Control-Allow-Origin as the world's
    // policy (cfg.cors_allowed_origins: '*' by default, a list of origins, or [] for none) allows, and
    // exposes ETag, which a browser page could not read otherwise. A preflight allows Authorization,
    // If-None-Match and If-Match.
    const WOW_MEDIA_TYPE = 'application/wow+json';
    const WOW_CONTEXT = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'wow-spec', 'context', 'wow.context.jsonld'), 'utf8');
    const WOW_OFFERS = [ WOW_MEDIA_TYPE, 'application/json' ];
    const CORS_POLICY = cfg.cors_allowed_origins === undefined ? '*' : cfg.cors_allowed_origins;
    // A world may sit at a path prefix (cfg.base_path, such as '/w/b'); its resource URLs are then the
    // base plus wow/... . Requests outside the prefix are not this world's.
    const BASE_PATH = cfg.base_path ? String(cfg.base_path).replace(/\/+$/, '') : '';
    // Which nodes a reader may not see (cfg.read_policy.refusesNode(graphId, nodeId) -> true). A refused
    // node answers 403, and the canonical form of its parent leaves it out.
    const READ_POLICY = cfg.read_policy && typeof cfg.read_policy.refusesNode === 'function' ? cfg.read_policy : null;

    function wowTypeFor(req)
    {
        return wowMediaTypes.negotiate(req.headers.accept, WOW_OFFERS).mediaType || WOW_MEDIA_TYPE;
    }

    function wowEtag(type, body)
    {
        return wowAsset.etagOf(type + '\n' + body);
    }

    // Last-Modified: the time of the last event whose `urls` named this resource, or, when nothing has
    // changed it since this server started, the start time.
    const STARTED_AT = new Date().toUTCString();
    function lastModifiedOf(path)
    {
        const m = /^\/wow\/spatial\/([^/]+)(\/node\/(-?\d+))?$/.exec(path);
        let key = path.replace(/^\//, '');
        if (m) key = 'wow/spatial/' + graphIdOf(decodeURIComponent(m[1])) + (m[2] ? '/node/' + m[3] : '');
        const changed = runtime.lastChangeOf(key);
        return changed ? new Date(changed).toUTCString() : STARTED_AT;
    }

    // Who may open the event stream from a browser: the same policy as cross-origin reads.
    function originAllowed(origin)
    {
        if (!origin || CORS_POLICY === '*') return true;
        return Array.isArray(CORS_POLICY) && CORS_POLICY.indexOf(origin) !== -1;
    }
    // A world that requires authorization for its stream (cfg.event_auth.tokens) expects the access token
    // as the stream's first message, and closes a stream without a valid one within 5 seconds (it waits
    // 4, so the close arrives inside the 5).
    const EVENT_AUTH = cfg.event_auth && Array.isArray(cfg.event_auth.tokens) ? cfg.event_auth : null;
    const EVENT_AUTH_TIMEOUT_MS = 4000;

    /**
     * Send a Web of Worlds resource. opts.tagged adds ETag and Last-Modified; on a GET that also
     * answers If-None-Match with 304 when the tag matches.
     */
    function sendWow(req, res, code, obj, opts)
    {
        opts = opts || {};
        wowAnnotateResponse(res, code, obj);
        const type = wowTypeFor(req);
        const body = JSON.stringify(obj, null, 2);
        const headers = {
            'Content-Type' : type,
            'Content-Length' : Buffer.byteLength(body),
            'Vary' : CORS_POLICY === '*' ? 'Accept' : 'Accept, Origin',
            'X-MSF-validation-Boundary' : 'application-level-handoff; native-teleport=false; conformance=false',
        };
        if (opts.tagged)
        {
            const etag = wowEtag(type, body);
            headers.ETag = etag;
            headers['Last-Modified'] = lastModifiedOf(res.__oslWowRequest ? res.__oslWowRequest.path : '');
            if (code === 200 && req.method !== 'PUT' && wowAsset.ifNoneMatchHits(req.headers['if-none-match'], etag))
            {
                res.writeHead(304, { ETag : etag, 'Last-Modified' : headers['Last-Modified'], Vary : headers.Vary });
                res.end();
                return;
            }
        }
        res.writeHead(code, headers);
        res.end(body);
    }

    /**
     * True when the request's If-Match does not match the current representation (`current`, as the
     * same request would GET it): the write must then be refused with 412. No If-Match: false.
     * Comparison is strong, so a weak tag never matches (RFC 9110 §13.1.1).
     */
    function ifMatchFails(req, current)
    {
        const raw = req.headers['if-match'];
        if (raw === undefined || String(raw).trim() === '') return false;
        if (String(raw).trim() === '*') return current === null || current === undefined;
        if (current === null || current === undefined) return true;
        const etag = wowEtag(wowTypeFor(req), JSON.stringify(current, null, 2));
        return !String(raw).split(',').map(tag => tag.trim()).some(tag => tag === etag);
    }

    /** The integer id of the graph a spatialID names, or null. */
    function graphIdOf(spatialID)
    {
        const spatial = runtime.getSpatialDescriptor(spatialID);
        return spatial ? spatial.id : null;
    }

    function refusesRead(graphId, nodeId)
    {
        return !!(READ_POLICY && READ_POLICY.refusesNode(graphId, nodeId));
    }

    /** A node as this reader may see it: refused children (and their subtrees) are left out. */
    function readableNode(graphId, node)
    {
        if (!READ_POLICY || !node || !Array.isArray(node.children)) return node;
        node.children = node.children
            .filter(child => !refusesRead(graphId, child && typeof child === 'object' ? child.id : child))
            .map(child => (child && typeof child === 'object' ? readableNode(graphId, child) : child));
        return node;
    }

    /** Cross-origin headers for a /wow/ response, as the world's policy allows. */
    function applyCors(req, res)
    {
        const origin = req.headers.origin;
        let allow = null;
        if (CORS_POLICY === '*') allow = '*';
        else if (Array.isArray(CORS_POLICY) && origin && CORS_POLICY.indexOf(origin) !== -1) allow = origin;
        if (!allow) return false;
        res.setHeader('Access-Control-Allow-Origin', allow);
        res.setHeader('Access-Control-Expose-Headers', 'ETag, Last-Modified, X-OSL-WoW-Validation');
        return true;
    }

    // Called by sendJson for EVERY JSON response. Non-/wow paths are untouched.
    function wowAnnotateResponse(res, code, obj)
    {
        const ctx = res.__oslWowRequest;
        if (!ctx) return;
        let verdict = null;
        try {
            verdict = wowContract.responseVerdict(ctx.method, ctx.path, code, obj, wowResponseCtx(res));
        } catch (e) {
            try { res.setHeader('X-OSL-WoW-Validation', 'error'); } catch (e2) {}
            console.warn('[wow-validate] verdict failed: ' + e.message);
            return;
        }
        if (!verdict) return;
        try {
            // A REQUEST-side failure already stated the verdict for this exchange
            // (`fail:<schema>`); never overwrite it with the response verdict.
            if (!res.getHeader('X-OSL-WoW-Validation'))
                res.setHeader('X-OSL-WoW-Validation', verdict.header);
            if (verdict.contract_note)
                res.setHeader('X-OSL-WoW-Contract', verdict.contract_note);
        } catch (e) {}
        if (verdict.valid === false)
            console.warn('[wow-validate] ' + verdict.operation + ' ' + code + ' response invalid ('
                + verdict.schema + '): ' + verdict.errorsText);
        else if (verdict.header === 'error')
            console.warn('[wow-validate] validator unavailable: ' + verdict.reason);
    }

    function sendJson(res, code, obj)
    {
        wowAnnotateResponse(res, code, obj);
        const body = JSON.stringify(obj, null, 2);
        res.writeHead(code, {
            'Content-Type' : 'application/json',
            'Content-Length' : Buffer.byteLength(body),
            'X-MSF-validation-Boundary' : 'application-level-handoff; native-teleport=false; conformance=false',
        });
        res.end(body);
    }

    /**
     * REQUEST-body verdict, derived from the contract's requestBody for this
     * operation. Returns null when the contract declares no body to check (the
     * handler then behaves exactly as it did before). On failure the verdict is
     * stated on the wire immediately, so the 400/422 the handler returns carries
     * `fail:<schema>` rather than the response-side verdict for that status.
     */
    function wowRequestVerdict(res, method, path, body, ctx)
    {
        let vr = null;
        try {
            vr = wowContract.requestVerdict(method, path, body, ctx);
        } catch (e) {
            vr = { valid : false, schema : 'unknown', available : false,
                errorsText : 'validator unavailable: ' + e.message };
        }
        if (vr && !vr.valid)
        {
            try { res.setHeader('X-OSL-WoW-Validation', 'fail:' + vr.schema); } catch (e) {}
        }
        return vr;
    }

    // ---- OpenSpatialAsset (the third WoW pillar) ---------
    //
    // Content negotiation across the spec's model/* media types + ETag /
    // conditional-GET / 304, over THIS world's REAL assets (files on disk + the
    // live hosted primitives). Full spec transcription and the labelled
    // interpretations (I12/I13) live in src/wow-asset.js. Built lazily so the node
    // still boots on a machine without the optional asset files.
    const PROOF_BOUNDARY_HDR = 'application-level-handoff; native-teleport=false; conformance=false';
    let assetRegistry = null;
    function getAssetRegistry()
    {
        if (!assetRegistry)
            assetRegistry = wowAsset.createAssetRegistry({
                // runtime.getSceneObjects() returns { objects:[...], ... }; the asset
                // registry wants the bare live-primitive array — adapt at the boundary.
                getSceneObjects : () => (runtime.getSceneObjects().objects || []),
                geoPoseFor : assetGeoPose,
                proofBoundary : runtime.getWowProofBoundary,
            });
        return assetRegistry;
    }
    /** A REAL asset geoPose for a hosted primitive (its live position through the
     * documented local-tangent mapping); null for files/elsewhere (no georef claim). */
    function assetGeoPose(asset)
    {
        if (asset && asset.kind === 'primitive' && asset.obj && Array.isArray(asset.obj.position))
            return runtime.wowGeoPoseFromLocal(asset.obj.position, 0, 0);
        return null;
    }

    // ---- OpenUserManifest ORIGIN (HEAD/ETag/302/403/404) --
    //
    // A genuinely SEPARATE web origin (its own port -> RFC 6454 scheme+host+PORT),
    // where a world DEREFERENCES a portable manifest rather than reading it inlined.
    // REUSES the UM Signature Profile A identity already produced by the runtime
    // (web/signing/) — never rebuilt. Transcription + interpretations (I14/I15) live
    // in src/wow-user-manifest.js. `start()` listens it on its own port.
    /** Serve one OpenSpatialAsset request (HEAD/GET). Returns true if handled. */
    function serveAsset(req, res, url, path, method)
    {
        if (method !== 'GET' && method !== 'HEAD')
        {
            sendJson(res, 405, { ok : false, error : 'method_not_allowed', method, path });
            return true;
        }
        const reg = getAssetRegistry();
        let rest = path.slice(wowAsset.ASSET_BASE_PREFIX.length);
        // The spec's `GET /wow/asset` (the Asset DESCRIPTOR) composes onto the asset
        // base as `/wow/asset/{assetId}/wow/asset` (interpretation I12).
        let wantDescriptor = false;
        const descSuffix = '/wow/asset';
        if (rest.endsWith(descSuffix)) { wantDescriptor = true; rest = rest.slice(0, -descSuffix.length); }
        if (rest.endsWith('/')) rest = rest.slice(0, -1);
        const assetId = decodeURIComponent(rest);

        const asset = reg.defineAsset(assetId);
        if (!asset) { sendJson(res, 404, { ok : false, error : 'asset_not_found', assetId }); return true; }

        // Data Security arm — 403 (restricted) / 404 (existence-concealed). Spec text (I13).
        const denied = reg.authorize(asset, req.headers);
        if (denied)
        {
            res.writeHead(denied.status, { 'Content-Type' : 'application/json',
                'X-MSF-validation-Boundary' : PROOF_BOUNDARY_HDR });
            res.end(method === 'HEAD' ? undefined
                : JSON.stringify({ ok : false, error : denied.error, assetId, why : denied.why }, null, 2));
            return true;
        }

        // The Asset DESCRIPTOR (GET /wow/asset -> 200 | 302 | 403 | 404).
        if (wantDescriptor)
        {
            if (asset.elsewhere)
            {
                res.writeHead(302, { Location : asset.elsewhere, 'X-MSF-validation-Boundary' : PROOF_BOUNDARY_HDR });
                res.end(); return true;
            }
            const body = Buffer.from(JSON.stringify(reg.assetDescriptor(asset), null, 2) + '\n', 'utf8');
            const tag = reg.etagOf(body);
            if (reg.ifNoneMatchHits(req.headers['if-none-match'], tag))
            { res.writeHead(304, { ETag : tag }); res.end(); return true; }
            res.writeHead(200, { 'Content-Type' : 'application/json', ETag : tag,
                'Content-Length' : String(body.length), 'X-MSF-validation-Boundary' : PROOF_BOUNDARY_HDR });
            res.end(method === 'HEAD' ? undefined : body);
            return true;
        }

        // The negotiated BYTES (spec HEAD / and GET /).
        if (asset.elsewhere)
        {
            // No local bytes -> "located elsewhere." GET 302; HEAD answers 200 with
            // the pointer's ETag (the spec lists no 302 for HEAD — I15 mirror).
            const pointer = Buffer.from(JSON.stringify({ location : asset.elsewhere }), 'utf8');
            const tag = reg.etagOf(pointer);
            if (method === 'HEAD')
            { res.writeHead(200, { ETag : tag, 'X-OSL-Asset-Elsewhere' : asset.elsewhere }); res.end(); return true; }
            res.writeHead(302, { Location : asset.elsewhere, ETag : tag }); res.end(); return true;
        }

        const reps = reg.representationsOf(asset);
        const offers = Array.from(reps.keys());
        const chosen = wowMediaTypes.negotiate(req.headers['accept'], offers);
        if (!chosen.mediaType)
        {
            // 406 — nothing on offer is acceptable. The spec's HEAD lists 200/403/404;
            // 406 is INHERITED from GET's negotiation and applied to both (declared).
            res.writeHead(406, { 'Content-Type' : 'application/json', 'X-OSL-Asset-Offers' : offers.join(', ') });
            res.end(method === 'HEAD' ? undefined
                : JSON.stringify({ ok : false, error : 'not_acceptable', assetId, offered : offers }, null, 2));
            return true;
        }
        const rep = reps.get(chosen.mediaType);
        if (reg.ifNoneMatchHits(req.headers['if-none-match'], rep.etag))
        { res.writeHead(304, { ETag : rep.etag, 'Content-Type' : chosen.mediaType }); res.end(); return true; }
        const headers = {
            'Content-Type' : chosen.mediaType,
            ETag : rep.etag,
            'Content-Length' : String(rep.bytes.length),
            'Content-Disposition' : 'inline; filename="' + assetId + '.' + rep.ext + '"',
            'X-OSL-Asset-Negotiated' : chosen.negotiated ? 'content-negotiated' : 'default-representation',
            'X-MSF-validation-Boundary' : PROOF_BOUNDARY_HDR,
        };
        if (rep.provisional) headers['X-OSL-Asset-Media-Type'] = 'PROVISIONAL (D8; not IANA-registered)';
        res.writeHead(200, headers);
        res.end(method === 'HEAD' ? undefined : rep.bytes);
        return true;
    }

    // Reads a JSON request body and settles exactly once: an empty body is {}, invalid JSON
    // or a broken stream is an error, and a body over MAX_BODY_BYTES is an error with status
    // 413. The rest of an oversized body is discarded, not buffered; the 413 answer closes
    // the connection (sendBodyError).
    const MAX_BODY_BYTES = 1e6;
    function readBody(req, cb)
    {
        let data = '';
        let settled = false;
        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            cb(err, value);
        };
        req.on('data', chunk => {
            if (settled) return;
            data += chunk;
            if (data.length > MAX_BODY_BYTES)
            {
                data = '';
                finish(Object.assign(new Error('payload_too_large'), { status : 413 }), null);
            }
        });
        req.on('end', () => {
            if (!data) return finish(null, {});
            try { finish(null, JSON.parse(data)); }
            catch (err) { finish(err, null); }
        });
        req.on('error', err => finish(err, null));
    }

    function sendBodyError(res, err)
    {
        if (err && err.status === 413)
        {
            res.setHeader('Connection', 'close');
            return sendJson(res, 413, { ok : false, error : 'payload_too_large', limit_bytes : MAX_BODY_BYTES });
        }
        return sendJson(res, 400, { ok : false, error : 'bad_json' });
    }

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1:' + cfg.http_port);
        let path = url.pathname;
        if (BASE_PATH)
        {
            if (path !== BASE_PATH && !path.startsWith(BASE_PATH + '/'))
            {
                res.writeHead(404, { 'Content-Type' : 'application/json' });
                res.end(JSON.stringify({ ok : false, error : 'outside_world_base_path', base_path : BASE_PATH, path }));
                return;
            }
            path = path.slice(BASE_PATH.length) || '/';
        }
        // HEAD on a Web of Worlds resource is answered as GET; Node sends the same header fields and no
        // body (RFC 9110 §9.3.2). The asset routes keep their own HEAD handling.
        const wowResourcePath = path === '/wow/world' || /^\/wow\/(spatial|portal|user|view)\//.test(path);
        const method = req.method === 'HEAD' && wowResourcePath ? 'GET' : req.method;

        if (path.startsWith('/wow/'))
        {
            const allowed = applyCors(req, res);
            if (method === 'OPTIONS')
            {
                if (allowed)
                {
                    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
                    res.setHeader('Access-Control-Allow-Headers',
                        'Authorization, Content-Type, Accept, If-None-Match, If-Match, X-OSL-WoW-Node-Form, X-OSL-WoW-Spatial-Form');
                    res.setHeader('Access-Control-Max-Age', '600');
                }
                res.writeHead(204);
                res.end();
                return;
            }
        }

        // the ONE place the request identity is
        // recorded, so sendJson() can ask the contract what this exchange was
        // supposed to carry. Every JSON response on this server flows through
        // sendJson, which is why enforcement cannot be forgotten at a call site.
        res.__oslWowRequest = { method, path };

        // ---- read-only GET routes ----
        if (method === 'GET' && path === '/healthz')
            // report the port actually LISTENED on (== cfg.http_port unless a
            // harness passed bind_port), never a port we are not on.
            return sendJson(res, 200, {
                ok : true,
                location_id : runtime.LOCATION_ID,
                world_id : runtime.WORLD_ID,
                node_role : runtime.NODE_ROLE,
                port : bindPort,
                fresh_demo_reset_contract_version : FRESH_DEMO_RESET_CONTRACT_VERSION,
            });

        if (method === 'GET' && path === '/wow/world')
            return sendWow(req, res, 200, runtime.getWowWorld(), { tagged : true });

        // The JSON-LD context that types node `properties` (iteration 3). Its terms are provisional.
        if ((method === 'GET' || req.method === 'HEAD') && path === '/wow/context.jsonld')
        {
            const body = WOW_CONTEXT;
            res.writeHead(200, { 'Content-Type' : 'application/ld+json', 'Content-Length' : Buffer.byteLength(body),
                ETag : wowEtag('application/ld+json', body) });
            return res.end(req.method === 'HEAD' ? undefined : body);
        }

        if (method === 'GET' && path === '/wow/location')
            return sendJson(res, 200, runtime.getWowLocation());

        if (method === 'GET' && path === '/wow/graph')
        {
            const graph = runtime.getWowGraph();
            if (!graph)
                return sendJson(res, 404, { ok : false, error : 'authored_graph_not_configured' });
            return sendJson(res, 200, graph);
        }

        if (method === 'GET' && path.startsWith('/wow/portal/'))
        {
            const portalId = decodeURIComponent(path.slice('/wow/portal/'.length));
            const proj = runtime.getWowPortal(portalId);
            if (!proj) return sendJson(res, 404, { ok : false, error : 'portal_not_found', portalId });
            return sendWow(req, res, 200, proj);
        }

        if (method === 'GET' && path.startsWith('/wow/user/'))
        {
            const userId = decodeURIComponent(path.slice('/wow/user/'.length));
            // serve the SIGNED OpenUserManifest identity
            // (UM Ed25519 / JCS-RFC8785 / did:key), fronted as a labeled non-
            // canonical additive field on the WoW user resource. Async (WebCrypto);
            // getWowUserSigned degrades honestly to unsigned on signer failure, and
            // this outer catch is a last-resort fall back to the plain unsigned
            // canonical projection so /wow/user never regresses.
            Promise.resolve()
                .then(() => runtime.getWowUserSigned(userId))
                .then((proj) => {
                    if (!proj) return sendJson(res, 404, { ok : false, error : 'user_not_found', userId });
                    return sendWow(req, res, 200, proj);
                })
                .catch(() => {
                    const proj = runtime.getWowUser(userId);
                    if (!proj) return sendJson(res, 404, { ok : false, error : 'user_not_found', userId });
                    return sendWow(req, res, 200, proj);
                });
            return;
        }

        // DELETE /wow/user/{userId}: the spec's other user operation. runtime.deleteWowUser()
        // answers 400 for this location's own hosted identity and 404 for an unknown user; a
        // live presence user departs through the normal presence path.
        if (method === 'DELETE' && path.startsWith('/wow/user/'))
        {
            let userId;
            try { userId = decodeURIComponent(path.slice('/wow/user/'.length)); }
            catch (e) { return sendJson(res, 400, { ok : false, error : 'invalid_user_value' }); }
            const r = runtime.deleteWowUser(userId);
            if (!r.ok) return sendJson(res, r.status, { ok : false, error : r.error, userId, reason : r.reason });
            return sendJson(res, 200, r.value);
        }

        // WoW `View` resource: the PlayerView camera seat.
        if (method === 'GET' && path.startsWith('/wow/view/'))
        {
            const viewId = decodeURIComponent(path.slice('/wow/view/'.length));
            const proj = runtime.getWowView(viewId);
            if (!proj) return sendJson(res, 404, { ok : false, error : 'view_not_found', viewId });
            return sendWow(req, res, 200, proj);
        }

        // OpenSpatialAsset — the third WoW pillar. HEAD/GET at
        // /wow/asset/{assetId}/ (content-negotiated, ETag'd bytes) and the Asset
        // descriptor at /wow/asset/{assetId}/wow/asset. This block owns the prefix.
        if (path.startsWith(wowAsset.ASSET_BASE_PREFIX))
            return serveAsset(req, res, url, path, method);

        // The Spatial Composition Graph and node CRUD:
        //   GET    /wow/spatial/{spatialID}                 -> the Spatial: graph id, root node id, GeoPose anchor
        //   GET    /wow/spatial/{spatialID}/node/{nodeId}   -> a Node, its subtree embedded
        //   POST   /wow/spatial/{spatialID}/node/{nodeId}   -> create child Nodes (body: Node[])
        //   PUT    /wow/spatial/{spatialID}/node/{nodeId}   -> update a Node, or move it by `parent`
        //   DELETE /wow/spatial/{spatialID}/node/{nodeId}   -> delete a Node and its subtree
        // A node is the canonical Node (children embedded) unless the request asks for the node form
        // `flat` (header X-OSL-WoW-Node-Form or ?nodeForm=): then it is the labeled OSLFlatNode, whose
        // children are integer ids. The graph's id is an integer; the string aliases it used to be
        // addressed by still resolve. This block fully owns the `/wow/spatial/` prefix.
        if (path.startsWith('/wow/spatial/'))
        {
            let rest = path.slice('/wow/spatial/'.length);
            if (rest.endsWith('/')) rest = rest.slice(0, -1);
            const marker = '/node/';
            const at = rest.indexOf(marker);
            const spatialID = decodeURIComponent(at === -1 ? rest : rest.slice(0, at));
            const nodeIdRaw = at === -1 ? null : decodeURIComponent(rest.slice(at + marker.length));

            if (!spatialID)
                return sendJson(res, 404, { ok : false, error : 'spatial_graph_not_found', path });

            const nodeForm = requestedNodeForm(req, url);

            // ---- the graph: /wow/spatial/{spatialID} ----
            if (nodeIdRaw === null)
            {
                if (method !== 'GET')
                    return sendJson(res, 405, { ok : false, error : 'method_not_allowed', method, path });
                const spatialForm = String(req.headers['x-osl-wow-spatial-form']
                    || url.searchParams.get('form') || '').toLowerCase();
                if (spatialForm === 'node')
                {
                    const root = runtime.getSpatialGraphRoot(spatialID, { form : nodeForm });
                    if (!root) return sendJson(res, 404, { ok : false, error : 'spatial_graph_not_found', spatialID });
                    try { res.setHeader('X-OSL-WoW-Spatial-Form', 'node'); res.setHeader('X-OSL-WoW-Node-Form', nodeForm); } catch (e) {}
                    return sendWow(req, res, 200, readableNode(graphIdOf(spatialID), root), { tagged : true });
                }
                const spatial = runtime.getSpatialDescriptor(spatialID);
                if (!spatial) return sendJson(res, 404, { ok : false, error : 'spatial_graph_not_found', spatialID });
                try { res.setHeader('X-OSL-WoW-Spatial-Form', 'descriptor'); } catch (e) {}
                return sendWow(req, res, 200, spatial, { tagged : true });
            }

            // ---- a node: /wow/spatial/{spatialID}/node/{nodeId} ----
            // The spec's nodeId path param is an integer; a non-integer is a 400.
            if (!/^-?\d+$/.test(nodeIdRaw))
                return sendJson(res, 400, { ok : false, error : 'invalid_node_id', nodeId : nodeIdRaw });
            const nodeId = Number(nodeIdRaw);
            const flat = nodeForm === 'flat';

            if (method === 'GET')
            {
                const node = runtime.getSpatialNode(spatialID, nodeId, { form : nodeForm });
                if (!node) return sendJson(res, 404, { ok : false, error : 'node_not_found', spatialID, nodeId });
                if (refusesRead(graphIdOf(spatialID), nodeId))
                    return sendJson(res, 403, { ok : false, error : 'node_read_refused', spatialID, nodeId });
                try { res.setHeader('X-OSL-WoW-Node-Form', nodeForm); } catch (e) {}
                return sendWow(req, res, 200, readableNode(graphIdOf(spatialID), node), { tagged : true });
            }

            if (method === 'POST')
            {
                return readBody(req, (err, body) => {
                    if (err) return sendBodyError(res, err);
                    try {
                        if (!Array.isArray(body))
                            return sendJson(res, 400, { ok : false, error : 'expected_node_array' });
                        // A transform that is an array but cannot be a node's placement (wrong length,
                        // last row, overflow, shear) is refused with a named reason before
                        // the contract's own verdict. A transform that is not an array is the contract's.
                        const badTransform = inspectIncomingTransforms(body, { arraysOnly : true });
                        if (badTransform)
                            return sendJson(res, badTransform.status, Object.assign(
                                { ok : false, error : badTransform.error, spatialID, nodeId }, badTransform.detail));
                        // Which schema the body is measured against is the contract's requestBody for
                        // this operation: `Node[]`, or `OSLFlatNode[]` when the form is `flat`.
                        const vr = wowRequestVerdict(res, method, path, body, { nodeForm : flat ? 'flat' : null });
                        if (vr && !vr.valid)
                        {
                            // Name the refusal when it is one of the structural ones (a child that is
                            // neither an id nor a node, ids on a create body, an embedded child in the
                            // flat form). The classifier is pure and stores nothing.
                            const structural = inspectIncomingForest(body, { flattenEmbedded : !flat, basePath : '$' });
                            if (structural)
                                return sendJson(res, structural.status, Object.assign(
                                    { ok : false, error : structural.error, spatialID, nodeId },
                                    structural.detail || {}));
                            return sendJson(res, 422, { ok : false, error : 'node_validation_failed', details : vr.errorsText });
                        }
                        const r = runtime.createSpatialNodes(spatialID, nodeId, body, { flattenEmbedded : !flat });
                        if (!r.ok)
                            return sendJson(res, r.status, Object.assign(
                                { ok : false, error : r.error, spatialID, nodeId }, r.detail || {}));
                        // Say, on the wire, what was stored against what was sent.
                        try {
                            res.setHeader('X-OSL-WoW-Node-Form', nodeForm);
                            res.setHeader('X-OSL-WoW-Nodes-Stored', String(r.stored) + '/' + String(r.requested));
                        } catch (e) {}
                        // Canonical: the nodes the caller sent, with their subtrees and every id assigned.
                        // Flat: every node stored, parents first.
                        const value = flat ? r.value
                            : r.top_level.map(id => runtime.getSpatialNode(spatialID, id, { form : 'canonical' }));
                        return sendWow(req, res, 200, value);
                    } catch (e) {
                        if (res.headersSent) return res.destroy();
                        return sendJson(res, 400, { ok : false, error : 'node_create_rejected', message : e.message });
                    }
                });
            }

            if (method === 'PUT')
            {
                return readBody(req, (err, body) => {
                    if (err) return sendBodyError(res, err);
                    try {
                        if (!body || typeof body !== 'object' || Array.isArray(body))
                            return sendJson(res, 400, { ok : false, error : 'expected_node_object' });
                        // A stale If-Match is a lost update: refuse it before anything is checked or stored.
                        // A node that does not exist answers 404, whatever the precondition (RFC 9110 §13.2.1).
                        const current = runtime.getSpatialNode(spatialID, nodeId, { form : nodeForm });
                        if (current && ifMatchFails(req, readableNode(graphIdOf(spatialID), current)))
                            return sendJson(res, 412, { ok : false, error : 'precondition_failed', spatialID, nodeId,
                                message : 'If-Match does not match the node\'s current entity tag; read the node again and retry' });
                        const badTransform = inspectIncomingTransforms(body, { arraysOnly : true, single : true });
                        if (badTransform)
                            return sendJson(res, badTransform.status, Object.assign(
                                { ok : false, error : badTransform.error, spatialID, nodeId }, badTransform.detail));
                        const vr = wowRequestVerdict(res, method, path, body, { nodeForm : flat ? 'flat' : null });
                        if (vr && !vr.valid)
                        {
                            // A PUT may carry the children it read, so ids are not a structural refusal
                            // here: a refused body is the contract's 422, or the store's named 422.
                            const structural = inspectIncomingForest([ body ],
                                { flattenEmbedded : !flat, allowIdRefs : true, basePath : '$' });
                            if (structural)
                                return sendJson(res, structural.status, Object.assign(
                                    { ok : false, error : structural.error, spatialID, nodeId },
                                    structural.detail || {}));
                            return sendJson(res, 422, { ok : false, error : 'node_validation_failed', details : vr.errorsText });
                        }
                        const r = runtime.updateSpatialNode(spatialID, nodeId, body, { form : nodeForm });
                        if (!r.ok)
                            return sendJson(res, r.status, Object.assign(
                                { ok : false, error : r.error, spatialID, nodeId }, r.detail || {}));
                        try { res.setHeader('X-OSL-WoW-Node-Form', nodeForm); } catch (e) {}
                        return sendWow(req, res, 200,
                            readableNode(graphIdOf(spatialID), runtime.getSpatialNode(spatialID, nodeId, { form : nodeForm })));
                    } catch (e) {
                        if (res.headersSent) return res.destroy();
                        return sendJson(res, 400, { ok : false, error : 'node_update_rejected', message : e.message });
                    }
                });
            }

            if (method === 'DELETE')
            {
                const current = runtime.getSpatialNode(spatialID, nodeId, { form : nodeForm });
                if (current && ifMatchFails(req, readableNode(graphIdOf(spatialID), current)))
                    return sendJson(res, 412, { ok : false, error : 'precondition_failed', spatialID, nodeId,
                        message : 'If-Match does not match the node\'s current entity tag; read the node again and retry' });
                const r = runtime.deleteSpatialNode(spatialID, nodeId);
                if (!r.ok) return sendJson(res, r.status, { ok : false, error : r.error, spatialID, nodeId });
                return sendJson(res, 200, Object.assign({ ok : true }, r.value));
            }

            return sendJson(res, 405, { ok : false, error : 'method_not_allowed', method, path });
        }

        if (method === 'GET' && path === '/debug/state')
            return sendJson(res, 200, runtime.getDebugState());

        // OMB fabric manifest: the world description this
        // node serves, projected live. Plain JSON, unsigned, labeled as such.
        // (Left byte-identical: /fabric.json keeps trust.signed:false + no CORS.)
        if (method === 'GET' && path === '/fabric.json')
            return sendJson(res, 200, runtime.getFabricManifest());

        // addressable spatial fabric portal prefetch reads.
        // Both are READ-ONLY (no state mutation) and labeled local-proof routes:
        //   GET /fabric/region?anchor_portal_id=...&radius_m=...
        //       -> only the entities within radius of the anchor portal, plus
        //          portal pose, spawn, occupancy summary, totals, freshness.
        //   GET /fabric/presence
        //       -> light occupancy summary for prefetch refresh polling.
        if (method === 'GET' && path === '/fabric/region')
        {
            const anchor = url.searchParams.get('anchor_portal_id')
                || ((runtime.getState().portals[0] || {}).portal_id);
            const radius = url.searchParams.get('radius_m');
            const chunked = url.searchParams.get('chunked');
            try {
                // chunked=1 selects the distance-banded
                // progressive read (budgets + truncation + continuation
                // cursor); without it the pre-006 single response is served
                // byte-identically.
                if (chunked === '1' || chunked === 'true')
                {
                    return sendJson(res, 200, runtime.getFabricRegionChunk(anchor, radius, {
                        scope : url.searchParams.get('scope'),
                        cursor : url.searchParams.get('cursor'),
                        max_entities : url.searchParams.get('max_entities'),
                        max_bytes : url.searchParams.get('max_bytes'),
                    }));
                }
                return sendJson(res, 200, runtime.getFabricRegion(anchor, radius));
            } catch (e) {
                return sendJson(res, 400, { ok : false, error : 'fabric_region_rejected', message : e.message });
            }
        }

        // the chunk layout expressed as a LABELED
        // 3D-Tiles-SHAPED hypothesis artifact (never a conformance claim).
        if (method === 'GET' && path === '/fabric/region/tileset-hypothesis')
        {
            const anchor = url.searchParams.get('anchor_portal_id')
                || ((runtime.getState().portals[0] || {}).portal_id);
            try {
                return sendJson(res, 200, runtime.getFabricRegionTilesetHypothesis(
                    anchor, url.searchParams.get('radius_m')));
            } catch (e) {
                return sendJson(res, 400, { ok : false, error : 'fabric_region_rejected', message : e.message });
            }
        }

        if (method === 'GET' && path === '/fabric/presence')
            return sendJson(res, 200, runtime.getFabricPresence());

        if (method === 'GET' && path === '/.well-known/spatial-fabric')
        {
            const s = runtime.getState();
            return sendJson(res, 200, {
                fabric_id : 'local-fabric-' + runtime.LOCATION_ID,
                location : runtime.LOCATION_ID,
                world_url : '/wow/world',
                location_url : '/wow/location',
                authored_graph_url : runtime.getWowGraph() ? '/wow/graph' : null,
                portals : s.portals.map(p => p.portal_id),
                session_endpoint : '/sessions',
                runtime_state_url : '/runtime-state',
                debug_state_url : '/debug/state',
                proof_boundary : runtime.getWowProofBoundary(),
            });
        }

        // ---- DEMO EXTENSION routes (labeled; NOT spec routes;
        // additive only — existing world-serving/handoff/relay untouched) ----
        if (method === 'GET' && path === '/demo/scene-objects')
            return sendJson(res, 200, runtime.getSceneObjects());

        if (method === 'GET' && path === '/demo/um/attach-point')
            return sendJson(res, 200, runtime.getUmAttachPoint());

        if (method === 'GET' && path === '/demo/portal-view')
        {
            const resolution = url.searchParams.get('resolution') || 'snapshot3d';
            const view = runtime.getPortalView(resolution);
            if (!view)
                return sendJson(res, 404, {
                    ok : false,
                    error : 'unknown_resolution',
                    resolution,
                    available : [ 'color', 'snapshot3d', 'splats' ],
                });
            return sendJson(res, 200, view);
        }

        if (method === 'POST' && path === '/demo/scene-objects/move')
        {
            return readBody(req, (err, body) => {
                if (err) return sendBodyError(res, err);
                try {
                    const obj = runtime.moveSceneObject(body && body.object_id, body && body.position);
                    return sendJson(res, 200, { ok : true, demo_extension : true, object : obj });
                } catch (e) {
                    return sendJson(res, 400, { ok : false, error : 'scene_object_move_rejected', message : e.message });
                }
            });
        }

        if (method === 'POST' && path === '/demo/portal/move')
        {
            return readBody(req, (err, body) => {
                if (err) return sendBodyError(res, err);
                try {
                    const portal = runtime.movePortal(body && body.position);
                    return sendJson(res, 200, { ok : true, demo_extension : true, portal });
                } catch (e) {
                    return sendJson(res, 400, { ok : false, error : 'portal_move_rejected', message : e.message });
                }
            });
        }

        // DEMO EXTENSION: read/set the OPTIONAL server
        // republish cadence (ambient drift of hosted objects). Default 0 = OFF
        // (behavior identical to pre-). Labeled demo extension; the
        // server-side mutation is PULLED by clients, never pushed/streamed.
        if (method === 'GET' && path === '/demo/republish-rate')
            return sendJson(res, 200, runtime.getRepublishRate());

        if (method === 'POST' && path === '/demo/republish-rate')
        {
            return readBody(req, (err, body) => {
                if (err) return sendBodyError(res, err);
                try {
                    const out = runtime.setRepublishRate(body && body.republish_rate_ms);
                    return sendJson(res, 200, out);
                } catch (e) {
                    return sendJson(res, 400, { ok : false, error : 'republish_rate_rejected', message : e.message });
                }
            });
        }

        // ---- mutating POST routes ----

        // explicit player presence session actions against
        // THIS location's registry. POST-only mutations — the GET
        // /fabric/presence read above stays read-only. A player registers/
        // heartbeats/departs only with its OWN currently-active server.
        if (method === 'POST' && path === '/fabric/presence/register')
        {
            return readBody(req, (err, body) => {
                if (err) return sendBodyError(res, err);
                try {
                    return sendJson(res, 201, runtime.registerPresence(body || {}));
                } catch (e) {
                    return sendJson(res, 400, { ok : false, error : 'presence_register_rejected', message : e.message });
                }
            });
        }

        if (method === 'POST' && path === '/fabric/presence/heartbeat')
        {
            return readBody(req, (err, body) => {
                if (err) return sendBodyError(res, err);
                try {
                    return sendJson(res, 200, runtime.heartbeatPresence(body || {}));
                } catch (e) {
                    return sendJson(res, 400, { ok : false, error : 'presence_heartbeat_rejected', message : e.message });
                }
            });
        }

        if (method === 'POST' && path === '/fabric/presence/depart')
        {
            return readBody(req, (err, body) => {
                if (err) return sendBodyError(res, err);
                try {
                    return sendJson(res, 200, runtime.departPresence(body || {}));
                } catch (e) {
                    return sendJson(res, 400, { ok : false, error : 'presence_depart_rejected', message : e.message });
                }
            });
        }

        if (method === 'POST' && (path === '/portal/exit-intent' || path === '/wow/portal/exit'))
        {
            return readBody(req, (err, body) => {
                if (err) return sendBodyError(res, err);
                try {
                    const portalId = (body && body.portal_id) || (runtime.getState().portals[0] || {}).portal_id;
                    // the crossing player's presence id rides the
                    // exit-intent, so the origin departs them from its OWN registry in the
                    // same transaction that authorizes the exit (no separate goodbye packet
                    // to lose, no window in which a player is registered in two worlds).
                    // Absent for observer / `#preview` windows — they register nobody.
                    const playerId = body && body.player_id ? String(body.player_id) : null;
                    const packet = runtime.recordPortalExitIntent(portalId, playerId);
                    return sendJson(res, 201, packet);
                } catch (e) {
                    return sendJson(res, 400, { ok : false, error : 'exit_intent_rejected', message : e.message });
                }
            });
        }

        if (method === 'POST' && (path === '/portal/arrival' || path === '/wow/portal/arrival'))
        {
            return readBody(req, (err, body) => {
                if (err) return sendBodyError(res, err);
                try {
                    const out = runtime.recordPortalArrival(body || {});
                    return sendJson(res, 201, { ok : true, applied : true, state : out });
                } catch (e) {
                    return sendJson(res, 400, { ok : false, error : 'portal_arrival_rejected', message : e.message });
                }
            });
        }

        if (method === 'POST' && path === '/movement')
        {
            return readBody(req, (err, body) => {
                if (err) return sendBodyError(res, err);
                const out = runtime.applyMovement(body || {});
                return sendJson(res, 200, { ok : true, avatar : out.avatar });
            });
        }

        if (method === 'POST' && path === '/reset')
        {
            const out = runtime.reset();
            // Capture the reset proof synchronously, before the newly armed
            // 100 ms ambient-republish timer can apply its first legitimate
            // drift. The operator still re-reads every surface through HTTP and
            // settles for live-client repopulation; this snapshot proves that
            // the reset owner itself restored its scene/portal/session seeds.
            return sendJson(res, 200, {
                ok : true,
                reset : true,
                fresh_demo_reset_contract_version : FRESH_DEMO_RESET_CONTRACT_VERSION,
                debug_state : out,
                reset_snapshot : {
                    presence : runtime.getFabricPresence(),
                    scene_objects : runtime.getSceneObjects(),
                    attach_point : runtime.getUmAttachPoint(),
                    republish : runtime.getRepublishRate(),
                },
            });
        }

        return sendJson(res, 404, { ok : false, error : 'not_found', path });
    });

    // ---- minimal RFC6455 WebSocket: /runtime-state (full-state) + /events -----
    //
    // a SECOND WS path `/events` carries TYPED,
    // GRANULAR WoW realtime envelopes (user_joined/left, node_created/updated/
    // deleted) — the LABELED NON-CANONICAL reference-impl convention
    // (wow-spec/OSL-WOW-CONTRACT.md §6), intentionally OUT of the OpenAPI HTTP
    // contract. The pre-015 `/runtime-state` full-state broadcast is preserved
    // BYTE-FOR-BYTE (same handshake, same `{type:'state',state}` frames); the
    // `/events` branch is purely additive and shares the frame encoder.
    server.on('upgrade', (req, socket) => {
        const url = new URL(req.url, 'http://127.0.0.1:' + cfg.http_port);
        let wsPath = url.pathname;
        if (BASE_PATH)
        {
            if (!wsPath.startsWith(BASE_PATH + '/')) { socket.destroy(); return; }
            wsPath = wsPath.slice(BASE_PATH.length);
        }
        if (wsPath !== '/runtime-state' && wsPath !== '/events')
        {
            socket.destroy();
            return;
        }
        // A stream from an origin this world does not allow is refused before the handshake.
        if (wsPath === '/events' && !originAllowed(req.headers.origin))
        {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.destroy();
            return;
        }
        const key = req.headers['sec-websocket-key'];
        const accept = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');

        function encodeFrame(str)
        {
            const payload = Buffer.from(str, 'utf8');
            const len = payload.length;
            let header;
            if (len < 126)
            {
                header = Buffer.alloc(2);
                header[1] = len;
            }
            else if (len < 65536)
            {
                header = Buffer.alloc(4);
                header[1] = 126;
                header.writeUInt16BE(len, 2);
            }
            else
            {
                header = Buffer.alloc(10);
                header[1] = 127;
                header.writeUInt32BE(0, 2);
                header.writeUInt32BE(len, 6);
            }
            header[0] = 0x81; // FIN + text
            return Buffer.concat([ header, payload ]);
        }

        function sendFrame(obj)
        {
            try { socket.write(encodeFrame(JSON.stringify(obj))); }
            catch (e) { /* socket gone */ }
        }

        function closeStream(code, reason)
        {
            const why = Buffer.from(String(reason || ''), 'utf8');
            const body = Buffer.concat([ Buffer.from([ (code >> 8) & 0xff, code & 0xff ]), why ]);
            try { socket.write(Buffer.concat([ Buffer.from([ 0x88, body.length ]), body ])); } catch (e) {}
            try { socket.end(); } catch (e) {}
            setTimeout(() => { try { socket.destroy(); } catch (e) {} }, 200);
        }

        let unsubscribe = () => {};
        let onMessage = null;
        if (wsPath === '/events')
        {
            // Additive realtime channel: an initial hello snapshot (current live
            // occupancy, so a late-joiner renders "who is here" at once) then the
            // granular delta events on every presence / node-CRUD change. No
            // per-connection Guest is minted — presence stays OSL's ghost-free
            // TTL registry (register/heartbeat/depart + expiry), never per-socket.
            // Iteration 3: `since=<revision>` replays what the client missed, or sends `resync` with the
            // current revision when that is no longer kept; live events follow either way.
            const sinceRaw = url.searchParams.get('since');
            const since = sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw);
            const begin = () => {
                sendFrame(runtime.getWowEventsHello());
                if (since !== null)
                {
                    const missed = runtime.eventsSince(since);
                    if (missed.resync) sendFrame({ type : 'resync', revision : missed.revision, time : runtime.currentRevision().time });
                    else for (const evt of missed.events) sendFrame(evt);
                }
                unsubscribe = runtime.subscribeEvents(evt => sendFrame(evt));
            };
            if (EVENT_AUTH)
            {
                const timer = setTimeout(() => closeStream(1008, 'no access token'), EVENT_AUTH_TIMEOUT_MS);
                onMessage = (text) => {
                    onMessage = null;
                    clearTimeout(timer);
                    let message = null;
                    try { message = JSON.parse(text); } catch (e) { /* not JSON */ }
                    if (message && message.type === 'auth' && EVENT_AUTH.tokens.indexOf(message.token) !== -1) begin();
                    else closeStream(1008, 'invalid access token');
                };
                socket.on('close', () => clearTimeout(timer));
            }
            else begin();
        }
        else
        {
            // /runtime-state: the pre-015 full-state broadcast, byte-for-byte.
            unsubscribe = runtime.subscribe(snapshot => sendFrame({ type : 'state', state : snapshot }));
        }

        // Inbound frames (client frames are masked, RFC 6455 §5.3): the first text message may carry the
        // access token; a close frame closes. Everything else is ignored, as before.
        let inbound = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            inbound = Buffer.concat([ inbound, chunk ]);
            while (inbound.length >= 2)
            {
                const opcode = inbound[0] & 0x0f;
                const masked = (inbound[1] & 0x80) !== 0;
                let len = inbound[1] & 0x7f;
                let at = 2;
                if (len === 126) { if (inbound.length < 4) return; len = inbound.readUInt16BE(2); at = 4; }
                else if (len === 127) { if (inbound.length < 10) return; len = Number(inbound.readBigUInt64BE(2)); at = 10; }
                const maskAt = at;
                if (masked) at += 4;
                if (inbound.length < at + len) return;
                const payload = Buffer.from(inbound.subarray(at, at + len));
                if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= inbound[maskAt + (i % 4)];
                inbound = inbound.subarray(at + len);
                if (opcode === 0x8) { closeStream(1000, ''); return; }
                if (opcode === 0x1 && onMessage) onMessage(payload.toString('utf8'));
            }
        });
        openSockets.add(socket);
        socket.on('close', () => { unsubscribe(); openSockets.delete(socket); });
        socket.on('error', () => { unsubscribe(); openSockets.delete(socket); });
    });

    // Track open sockets so tests can force a clean, race-free shutdown.
    const openSockets = new Set();
    server.on('connection', s => {
        openSockets.add(s);
        s.on('close', () => openSockets.delete(s));
    });
    function closeAll()
    {
        return new Promise(resolve => {
            // stop the optional republish timer so it never
            // outlives the server (keeps headless/e2e teardown clean).
            try { if (typeof runtime.stopRepublishTimer === 'function') runtime.stopRepublishTimer(); } catch (e) {}
            // same rule for the presence expiry sweeper.
            try { if (typeof runtime.stopPresenceSweeper === 'function') runtime.stopPresenceSweeper(); } catch (e) {}
            try { if (typeof runtime.stopSimulator === 'function') runtime.stopSimulator(); } catch (e) {}
            try { if (mirrors) mirrors.stop(); } catch (e) {}
            for (const s of openSockets) { try { s.destroy(); } catch (e) {} }
            openSockets.clear();
            // also tear down the OpenUserManifest origin (safe
            // even if it never started listening) so teardown stays race-free.
            server.close(() => resolve());
        });
    }

    return { server, runtime, cfg, closeAll, getAssetRegistry, mirrors };
}

function start(role, extraOpts) {
    const built = createServer(role, extraOpts);
    const { server, runtime, cfg } = built;
    const bindPort = Number(cfg.bind_port) || cfg.http_port;
    return new Promise((resolve) => {
        server.listen(bindPort, '127.0.0.1', () => {
            built.bound_port = bindPort;
            console.log('[node][' + runtime.LOCATION_ID + '] listening on http://127.0.0.1:' + bindPort);
            resolve(built);
        });
    });
}
module.exports = { createServer, start };
