'use strict';

/*
 * Iteration 6 (permissions): each world's own small authorization server, for the Lab's tests and demo, and the
 * check every request to that world passes. It follows decision 5, option 1 (the roadmap's "Iteration 6.
 * Permissions"): OAuth 2.0 bearer tokens, each bound to one world; each world keeps its own grant records.
 *
 * THE SETTING. A world's `auth` is "required" or "off" (default "off"). Off, nothing here runs: the world answers as
 * it always has (its open reads, and the local-only rule for writes). Required, every request needs a token and a
 * grant, except the open routes world-auth-policy.js names. The local-only placement rule (local-only.js) stays as
 * it is: a write needs both, the local-only conditions and a token with `write`.
 *
 * THE AUTHORIZATION SERVER (cfg.auth_server):
 *   resource      the world's base URL; every token this world accepts names it as its audience (RFC 8707). Default:
 *                 the handshake's identity base, else http://127.0.0.1:{port}{base_path}/.
 *   issuer        the issuer identifier (default: the resource). Two worlds of one operator may share one, with
 *                 one signing key; then only the audience tells their tokens apart.
 *   signing_seed  a 32-byte Ed25519 seed in hex (default: a key made when the world starts).
 *   clients       [{ client_id, client_secret }]: who may ask the token endpoint for a token, each as itself (the
 *                 client id is the subject of its grant records). Secrets are kept as SHA-256 digests.
 *   grants        [{ subject, scope, resource, expires_at?, acting_for?, subject_issuer? }]: the grant records the
 *                 world starts with. The resource is "world", "users" or one node (world-auth-policy.js). A record
 *                 with acting_for lets its subject act for that party (delegation, below), and covers nothing the
 *                 subject asks for with its own token. The world holds them; grants.add() and grants.withdraw()
 *                 change them.
 *   trusted_issuers [{ issuer, public_key }]: the other authorization servers whose tokens this world accepts as the
 *                 subject of a token exchange (public_key: the issuer's Ed25519 key, 32 bytes in hex). trust.add()
 *                 and trust.withdraw() change the list; a withdrawn issuer's tokens are refused from then on.
 *   token_ttl_s   how long a token lives (default 300 s).
 * Served (outside the world's base path, as RFC 9728 §3 and RFC 8414 §3 derive the addresses):
 *   GET {origin}/.well-known/oauth-protected-resource{path prefix}     protected resource metadata: resource (the
 *       base URL), authorization_servers, scopes_supported, bearer_methods_supported ["header"]
 *   GET {origin}/.well-known/oauth-authorization-server{issuer path}   authorization server metadata
 * and below the base:
 *   POST {base}oauth/token   client credentials (RFC 6749 §4.4), with the client's secret (HTTP Basic or the body),
 *       an optional `scope` and an optional `resource` (RFC 8707), which must be this world's base URL. The token
 *       carries only scopes this world's grant records hold for that client.
 *     and token exchange (RFC 8693, grant_type urn:ietf:params:oauth:grant-type:token-exchange): see DELEGATION.
 *
 * TOKENS are short-lived signed values: a JWT access token (RFC 9068 shape: typ at+jwt), signed with Ed25519 by the
 * Lab's own signing code (web/signing, EdDSA, RFC 8037), carrying iss, aud (the base URL), sub, client_id, scope,
 * iat, exp and jti, and, when issued by exchange, act (and sub_iss). No new crypto dependency.
 *
 * THE CHECK (gate). A request outside the open routes needs `Authorization: Bearer <token>` (RFC 6750 §2.1; a token
 * in a URL is refused with 400 invalid_request, so none is ever accepted from one). No token: 401 with
 * `WWW-Authenticate: Bearer realm=...` and no error code. A token that does not verify, is expired, or was issued
 * for another audience: 401 with error="invalid_token". A token whose scopes, or whose holder's grant records here,
 * do not cover the request: 403 with error="insufficient_scope" and the scope needed. The error codes are in the
 * WWW-Authenticate header (RFC 6750 §3 and §3.1), and repeated in the JSON body. The 401 carries no
 * resource_metadata parameter: RFC 9728 §3.3 would then require the metadata's resource to equal the request's own
 * URL, which differs from the base URL for every resource below it. The grant records are read at each request, so
 * a withdrawn grant refuses the holder's next request.
 *
 * STREAMS. A browser cannot add a header to a WebSocket, so on /events and /runtime-state the token is the stream's
 * first message ({ "type": "auth", "token": "..." }). A stream with no valid token, or whose holder has no observe
 * grant, is closed (1008) before anything is sent; one whose grant is withdrawn, or whose token expires, is closed
 * within 5 seconds (at once on a withdrawal; a sweep each second catches expiry).
 *
 * DELEGATION (RFC 8693, the delegation form: there is always an actor). An exchange takes:
 *   subject_token  the token of the party acted for: a token of this world, or of an issuer on its trusted list
 *                  whose audience is this world's base URL or the acting party. Anything else: 400 invalid_request
 *                  (RFC 8693 §2.2.2), also from an issuer the world has stopped trusting.
 *   actor_token    a token of this world for the acting party (an agent, a helper, or a host named by its base
 *                  URL), as its client credentials gave it; not itself a token issued by exchange.
 *   resource       optional; this world's base URL only (else invalid_target).
 * The party acted for is the subject token's current actor when it has one (a chain), else its subject. The world
 * issues the token only when a grant record lets the actor act for that party (subject = actor, acting_for = that
 * party, subject_issuer = its issuer when it is not this world); else 400 invalid_request. The token keeps the
 * subject (sub, and sub_iss when another issuer vouched for it), names the actor in `act` with the subject token's
 * own `act` nested inside (RFC 8693 §4.1: the outermost act is the current actor), and carries the scopes of the
 * actor's grant records for that party (narrowed by `scope`). Its life ends no later than the subject token's.
 * A request with such a token is decided on the current actor and its grant record for the party it acts for, read
 * at each request (so withdrawing that record refuses the actor's next request), not on the subject's own grants.
 * Every decision on a verified token is logged (decisions()): the method, the path, the subject and its issuer, the
 * whole chain of actors (current first) and allowed or refused.
 *
 * PEOPLE. A reader without the presence grant (world-auth-policy.js) reads every path that shows people without
 * them: GET /fabric/presence, /debug/state, /fabric/region, the World's list of people, the `users` list in the
 * /events hello, the user events (their revision kept) and the /runtime-state snapshots. GET /wow/user/{userId}
 * needs that grant itself.
 *
 * THE JOIN. With `auth` required, POST /wow/user needs enter, and its answer names the scopes granted: `scope`,
 * the scopes this world's active grant records hold for the visitor, each once, in the order read, observe, write,
 * enter. The User the join makes is the visitor's own, the only one its DELETE may remove.
 */

const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const policy = require('./world-auth-policy');

const SIGNING = pathToFileURL(path.join(__dirname, '..', '..', '..', 'web', 'signing', 'index.mjs')).href;
let signingLib = null;
const signing = () => (signingLib = signingLib || import(SIGNING));

const DEFAULT_TTL_S = 300;
const WATCH_MS = 1000;
const MODES = Object.freeze([ 'required', 'off' ]);
const TOKEN_PATH = '/oauth/token';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const SUBJECT_TOKEN_TYPES = new Set([ ACCESS_TOKEN_TYPE, 'urn:ietf:params:oauth:token-type:jwt' ]);
const LOG_SIZE = 1000;
const BEARER = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)\s*$/i;

/** The world's auth setting: "required" or "off" (default). Anything else stops the world from starting. */
function authMode(cfg)
{
    const v = cfg ? cfg.auth : undefined;
    if (v === undefined || v === null || v === 'off') return 'off';
    if (v === 'required') return 'required';
    throw new Error('the world setting auth must be one of ' + MODES.join(', ') + ', not ' + JSON.stringify(v));
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (text) => Buffer.from(String(text), 'base64url');
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest();
const quote = (text) => String(text).replace(/["\\]/g, '');

/** The actors of a token's `act` claim chain, the current actor first ([] for none), or null when it is malformed. */
function actorsOf(claims)
{
    const out = [];
    let act = claims.act;
    while (act !== undefined)
    {
        if (!act || typeof act !== 'object' || typeof act.sub !== 'string' || !act.sub || out.length >= 8) return null;
        out.push({ sub : act.sub });
        act = act.act;
    }
    return out;
}

/**
 * The world's grant records: { id, subject, scope, resource, granted_at, expires_at, withdrawn_at, acting_for,
 * subject_issuer }. acting_for (with subject_issuer, null for this world's own subjects) marks a record that lets
 * its subject act for that party; such a record covers none of the subject's own requests.
 */
function createGrantStore(now)
{
    const records = [];
    const listeners = new Set();
    let next = 1;
    const isActive = (r, at) => !r.withdrawn_at && (!r.expires_at || Date.parse(r.expires_at) > at);
    const actingFor = (r, principal) => !!r.acting_for && r.acting_for === principal.sub && (r.subject_issuer || null) === (principal.iss || null);
    const changed = (rec) => { for (const fn of listeners) { try { fn(rec); } catch (e) { /* a listener's own failure */ } } };
    return {
        add({ subject, scope, resource, expires_at, acting_for, subject_issuer })
        {
            if (typeof subject !== 'string' || !subject) throw new Error('a grant names a subject');
            if (!policy.SCOPES.includes(scope)) throw new Error('a grant names one of the scopes ' + policy.SCOPES.join(', ') + ', not ' + JSON.stringify(scope));
            const res = resource === undefined ? 'world' : resource;
            const problem = policy.grantProblem(scope, res);
            if (problem) throw new Error(problem);
            if (acting_for !== undefined && acting_for !== null && (typeof acting_for !== 'string' || !acting_for)) throw new Error('a grant for acting names the party acted for');
            const rec = { id : 'grant-' + next++, subject, scope, resource : res, granted_at : new Date(now()).toISOString(), expires_at : expires_at || null, withdrawn_at : null, acting_for : acting_for || null, subject_issuer : acting_for ? (subject_issuer || null) : null };
            records.push(rec);
            changed(rec);
            return Object.assign({}, rec);
        },
        withdraw(id)
        {
            const rec = records.find((r) => r.id === id);
            if (!rec) return null;
            if (!rec.withdrawn_at) rec.withdrawn_at = new Date(now()).toISOString();
            changed(rec);
            return Object.assign({}, rec);
        },
        holds(subject, scope, resource)
        {
            const at = now();
            return records.some((r) => r.subject === subject && !r.acting_for && r.scope === scope && policy.covers(r.resource, resource) && isActive(r, at));
        },
        /** Whether `actor` holds a record that lets it act for `principal` ({ sub, iss }, iss null for this world) and covers scope and resource. */
        holdsFor(actor, principal, scope, resource)
        {
            const at = now();
            return records.some((r) => r.subject === actor && actingFor(r, principal) && r.scope === scope && policy.covers(r.resource, resource) && isActive(r, at));
        },
        /** The subject's own active records (records for acting left out). */
        active(subject)
        {
            const at = now();
            return records.filter((r) => r.subject === subject && !r.acting_for && isActive(r, at)).map((r) => Object.assign({}, r));
        },
        /** The active records that let `actor` act for `principal`. */
        activeFor(actor, principal)
        {
            const at = now();
            return records.filter((r) => r.subject === actor && actingFor(r, principal) && isActive(r, at)).map((r) => Object.assign({}, r));
        },
        records : () => records.map((r) => Object.assign({}, r)),
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
}

/** The issuers whose tokens a world accepts as the subject of an exchange: { issuer, public_key, trusted_at, withdrawn_at }. */
function createTrustStore(now)
{
    const entries = [];
    return {
        add({ issuer, public_key })
        {
            if (typeof issuer !== 'string' || !issuer) throw new Error('a trusted issuer names its issuer identifier');
            if (!/^[0-9a-f]{64}$/i.test(String(public_key || ''))) throw new Error('a trusted issuer gives its Ed25519 public key as 64 hex digits');
            const entry = { issuer, public_key : String(public_key).toLowerCase(), trusted_at : new Date(now()).toISOString(), withdrawn_at : null };
            entries.push(entry);
            return Object.assign({}, entry);
        },
        /** Stop trusting `issuer`: its tokens are refused as subject tokens from now on. */
        withdraw(issuer)
        {
            let n = 0;
            for (const e of entries) if (e.issuer === issuer && !e.withdrawn_at) { e.withdrawn_at = new Date(now()).toISOString(); n++; }
            return n;
        },
        /** The trusted entry for `issuer`, or null when the world does not (or no longer) trust it. */
        active(issuer)
        {
            return entries.find((e) => e.issuer === issuer && !e.withdrawn_at) || null;
        },
        list : () => entries.map((e) => Object.assign({}, e)),
    };
}

/**
 * The authorization server and the check of one world, or null when its auth setting is "off".
 * deps: { basePath, port, cors(req, res) }.
 */
function createWorldAuth(cfg, deps)
{
    if (authMode(cfg) === 'off') return null;
    deps = deps || {};
    const now = deps.now || (() => Date.now());
    const settings = cfg.auth_server || {};
    const basePath = deps.basePath || '';
    const withSlash = (u) => (String(u).endsWith('/') ? String(u) : String(u) + '/');
    const RESOURCE = withSlash(settings.resource || (cfg.handshake && cfg.handshake.base) || ('http://127.0.0.1:' + (deps.port || cfg.http_port) + basePath + '/'));
    const ISSUER = String(settings.issuer || RESOURCE);
    const TTL_S = Number.isFinite(settings.token_ttl_s) && settings.token_ttl_s > 0 ? settings.token_ttl_s : DEFAULT_TTL_S;
    // RFC 9728 §3.1 and RFC 8414 §3.1: the well-known name goes between the host and the path, and a terminating
    // slash of the path is removed first.
    const suffixOf = (u) => new URL(u).pathname.replace(/\/+$/, '');
    const PRM_PATH = '/.well-known/oauth-protected-resource' + suffixOf(RESOURCE);
    const AS_PATH = '/.well-known/oauth-authorization-server' + suffixOf(ISSUER);
    const TOKEN_ENDPOINT = RESOURCE + TOKEN_PATH.slice(1);

    const grants = createGrantStore(now);
    for (const g of settings.grants || []) grants.add(g);
    const trust = createTrustStore(now);
    for (const t of settings.trusted_issuers || []) trust.add(t);
    const log = [];
    const clients = new Map((settings.clients || []).map((c) => [ String(c.client_id), sha256(c.client_secret) ]));
    const owners = new Map();

    let keyPromise = null;
    function key()
    {
        if (!keyPromise)
            keyPromise = signing().then(async (lib) => {
                const seed = settings.signing_seed ? lib.hexToBytes(settings.signing_seed) : (await lib.generateKeyPair()).seed;
                return { lib, privateKey : await lib.importPrivateKey(seed), publicKey : await lib.derivePublicKeyRaw(seed) };
            });
        return keyPromise;
    }

    /** The scopes this world's active grant records hold for `subject`, each once, in the order of SCOPES. */
    function grantedScopes(subject)
    {
        const held = new Set(grants.active(subject).map((r) => r.scope));
        return policy.SCOPES.filter((s) => held.has(s));
    }
    /** The join answer's `scope`: the scopes granted, as a space-delimited list. */
    function grantedScope(subject)
    {
        return grantedScopes(subject).join(' ');
    }

    /** A token for `subject`, with the scopes asked for that its grant records hold (all of them by default); null when none. */
    async function issueToken(subject, opts)
    {
        opts = opts || {};
        const granted = grantedScopes(subject);
        const asked = opts.scope === undefined ? granted : String(opts.scope).split(' ').filter(Boolean);
        const scopes = policy.SCOPES.filter((s) => asked.includes(s) && granted.includes(s));
        if (!scopes.length) return null;
        const iat = Math.floor(now() / 1000);
        const ttl = Number.isFinite(opts.ttl_s) ? opts.ttl_s : TTL_S;
        const claims = { iss : ISSUER, aud : RESOURCE, sub : subject, client_id : opts.client_id || subject, scope : scopes.join(' '), iat, exp : iat + ttl, jti : crypto.randomBytes(12).toString('hex') };
        return signClaims(claims);
    }

    /** A JWT access token (typ at+jwt, EdDSA) carrying `claims`, signed with this world's key. */
    async function signClaims(claims)
    {
        const { lib, privateKey } = await key();
        const header = { alg : 'EdDSA', typ : 'at+jwt' };
        const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(claims));
        const signature = await lib.signBytes(new Uint8Array(Buffer.from(input, 'utf8')), privateKey);
        return input + '.' + b64u(signature);
    }

    /** This world's public key (Ed25519, 32 bytes) in hex: what another world lists to trust its tokens as subject tokens. */
    async function publicKeyHex()
    {
        const { lib, publicKey } = await key();
        return lib.bytesToHex(publicKey);
    }

    /** The scopes of the records that let `actor` act for `principal` ({ sub, iss }), each once, in the order of SCOPES. */
    function grantedScopesFor(actor, principal)
    {
        const held = new Set(grants.activeFor(actor, principal).map((r) => r.scope));
        return policy.SCOPES.filter((s) => held.has(s));
    }

    /** The audience test: a token is for this world only when it names this world's base URL, exactly (RFC 8707). */
    function audienceIsThisWorld(aud)
    {
        return aud === RESOURCE;
    }

    /** { ok, claims, scopes } or { ok: false, reason } for a token this world is shown. */
    async function verifyToken(token)
    {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return { ok : false, reason : 'the token is not a signed value' };
        let header = null;
        let claims = null;
        try { header = JSON.parse(fromB64u(parts[0]).toString('utf8')); claims = JSON.parse(fromB64u(parts[1]).toString('utf8')); }
        catch (e) { return { ok : false, reason : 'the token cannot be read' }; }
        if (!header || header.alg !== 'EdDSA' || header.typ !== 'at+jwt' || !claims || typeof claims !== 'object') return { ok : false, reason : 'the token is not an access token of this kind' };
        const { lib, publicKey } = await key();
        const signed = await lib.verifyBytes(new Uint8Array(Buffer.from(parts[0] + '.' + parts[1], 'utf8')), new Uint8Array(fromB64u(parts[2])), publicKey);
        if (!signed) return { ok : false, reason : 'the token\'s signature does not verify' };
        if (claims.iss !== ISSUER) return { ok : false, reason : 'the token was issued by another authorization server' };
        if (!audienceIsThisWorld(claims.aud)) return { ok : false, reason : 'the token was issued for another world' };
        if (!(Number.isFinite(claims.exp) && now() / 1000 < claims.exp)) return { ok : false, reason : 'the token has expired' };
        if (typeof claims.sub !== 'string' || typeof claims.scope !== 'string') return { ok : false, reason : 'the token names no subject or scope' };
        const actors = actorsOf(claims);
        if (!actors) return { ok : false, reason : 'the token\'s act claim is not a chain of actors' };
        return { ok : true, claims, scopes : claims.scope.split(' ').filter(Boolean), actors };
    }

    /**
     * A subject token for an exchange whose acting party is `actorSub`: a token of this world (verifyToken), or one of
     * an issuer this world trusts, signed with that issuer's key, not expired, whose audience is this world's base URL
     * or the acting party. { ok, claims, scopes, actors, foreign } or { ok: false, reason }.
     */
    async function verifySubjectToken(token, actorSub)
    {
        const parts = String(token || '').split('.');
        let header = null;
        let claims = null;
        try { header = JSON.parse(fromB64u(parts[0]).toString('utf8')); claims = JSON.parse(fromB64u(parts[1]).toString('utf8')); }
        catch (e) { header = null; claims = null; }
        if (parts.length !== 3 || !header || !claims || typeof claims !== 'object') return { ok : false, reason : 'the subject token is not a signed value' };
        if (claims.iss === ISSUER) return verifyToken(token);
        const entry = trust.active(claims.iss);
        if (!entry) return { ok : false, reason : 'the subject token\'s issuer is not one this world trusts' };
        if (header.alg !== 'EdDSA') return { ok : false, reason : 'the subject token is not signed with EdDSA' };
        const { lib } = await key();
        const signed = await lib.verifyBytes(new Uint8Array(Buffer.from(parts[0] + '.' + parts[1], 'utf8')), new Uint8Array(fromB64u(parts[2])), lib.hexToBytes(entry.public_key));
        if (!signed) return { ok : false, reason : 'the subject token\'s signature does not verify with its issuer\'s key' };
        const lapsed = !Number.isFinite(claims.exp) || claims.exp <= now() / 1000;
        if (lapsed) return { ok : false, reason : 'the subject token has expired' };
        const audiences = [].concat(claims.aud);
        if (!audiences.includes(RESOURCE) && !audiences.includes(actorSub)) return { ok : false, reason : 'the subject token names neither this world nor the acting party as its audience' };
        if (typeof claims.sub !== 'string' || !claims.sub) return { ok : false, reason : 'the subject token names no subject' };
        if (claims.act !== undefined) return { ok : false, reason : 'a subject token of another issuer that names actors is not accepted' };
        return { ok : true, claims, scopes : String(claims.scope || '').split(' ').filter(Boolean), actors : [], foreign : true };
    }

    /** The issuer that vouches for a token's subject: null for this world's own, else that issuer. */
    function issuerOf(claims)
    {
        if (claims.iss !== ISSUER) return claims.iss;
        return claims.sub_iss || null;
    }
    /** The party a verified token's current actor acts for: the next actor of the chain, else the subject. */
    function partyActedFor(verified)
    {
        if (verified.actors.length > 1) return { sub : verified.actors[1].sub, iss : null };
        return { sub : verified.claims.sub, iss : issuerOf(verified.claims) };
    }
    /** The party a new actor acts for when it is handed this token: its current actor, else its subject. */
    function currentParty(verified)
    {
        if (verified.actors.length) return { sub : verified.actors[0].sub, iss : null };
        return { sub : verified.claims.sub, iss : issuerOf(verified.claims) };
    }

    /** Whether a verified token, and its holder's grant records here, cover `need`. */
    function covers(verified, need)
    {
        if (verified.actors && verified.actors.length) return actorCovers(verified, need);
        return verified.scopes.includes(need.scope) && grants.holds(verified.claims.sub, need.scope, need.resource);
    }
    /**
     * A token issued by exchange is decided on its current actor (the outermost act, RFC 8693 §4.1) and that actor's
     * grant record for the party it acts for, not on the subject's own grants.
     */
    function actorCovers(verified, need)
    {
        const actor = verified.actors[0];
        const principal = partyActedFor(verified);
        return verified.scopes.includes(need.scope) && grants.holdsFor(actor.sub, principal, need.scope, need.resource);
    }

    /** One decision on a verified token, logged with the subject and the whole chain of actors (current first). */
    function note(req, p, verified, decision)
    {
        log.push({
            at : new Date(now()).toISOString(), method : req.method, path : p,
            subject : verified.claims.sub, subject_issuer : issuerOf(verified.claims),
            actors : verified.actors.map((a) => a.sub),
            decision,
        });
        if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
    }

    /** Whether the holder of a verified token is shown people (the presence grant), read now. */
    function presenceOf(verified)
    {
        return covers(verified, policy.PRESENCE_GRANT);
    }

    /** The WWW-Authenticate challenge (RFC 6750 §3): realm and, for a refusal with a reason, the error code. */
    function challenge(error, need, description)
    {
        const params = [ 'realm="' + quote(RESOURCE) + '"' ];
        if (error) params.push('error="' + error + '"');
        if (error && description) params.push('error_description="' + quote(description) + '"');
        if (need && need.scope) params.push('scope="' + need.scope + '"');
        return 'Bearer ' + params.join(', ');
    }

    function refuse(req, res, status, error, need, description)
    {
        if (deps.cors) { try { deps.cors(req, res); } catch (e) { /* no cross-origin headers */ } }
        if (res.getHeader('Access-Control-Allow-Origin')) res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, ETag, Last-Modified, X-OSL-WoW-Validation');
        const body = JSON.stringify({ ok : false, error : error || 'unauthorized', ...(description ? { error_description : description } : {}), ...(need && need.scope ? { scope : need.scope } : {}) });
        res.writeHead(status, {
            'WWW-Authenticate' : challenge(error, need, description),
            'Content-Type' : 'application/json',
            'Content-Length' : Buffer.byteLength(body),
            'Cache-Control' : 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
    }

    function sendMeta(req, res, obj)
    {
        const body = JSON.stringify(obj, null, 2);
        res.writeHead(200, { 'Content-Type' : 'application/json', 'Content-Length' : Buffer.byteLength(body), 'Access-Control-Allow-Origin' : '*', 'Cache-Control' : 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : body);
    }

    /** Protected resource metadata (RFC 9728 §2). Its resource is the world's base URL. */
    function resourceMetadata()
    {
        return {
            resource : RESOURCE,
            authorization_servers : [ ISSUER ],
            scopes_supported : policy.SCOPES.slice(),
            bearer_methods_supported : [ 'header' ],
            resource_name : 'world at ' + RESOURCE,
        };
    }

    /** Authorization server metadata (RFC 8414 §2). */
    function serverMetadata()
    {
        return {
            issuer : ISSUER,
            token_endpoint : TOKEN_ENDPOINT,
            grant_types_supported : [ 'client_credentials', TOKEN_EXCHANGE ],
            token_endpoint_auth_methods_supported : [ 'client_secret_basic', 'client_secret_post' ],
            scopes_supported : policy.SCOPES.slice(),
            response_types_supported : [],
        };
    }

    function tokenError(res, status, error, description)
    {
        const body = JSON.stringify({ error, ...(description ? { error_description : description } : {}) });
        const headers = { 'Content-Type' : 'application/json', 'Content-Length' : Buffer.byteLength(body), 'Cache-Control' : 'no-store' };
        if (status === 401) headers['WWW-Authenticate'] = 'Basic realm="' + quote(ISSUER) + '"';
        res.writeHead(status, headers);
        res.end(body);
    }

    function clientOf(req, form)
    {
        let id = null;
        let secret = null;
        const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(req.headers.authorization || ''));
        if (basic)
        {
            const text = Buffer.from(basic[1], 'base64').toString('utf8');
            const at = text.indexOf(':');
            if (at > 0) { id = decodeURIComponent(text.slice(0, at)); secret = decodeURIComponent(text.slice(at + 1)); }
        }
        else if (form.get('client_id')) { id = form.get('client_id'); secret = form.get('client_secret'); }
        if (!id || secret === null || !clients.has(id)) return null;
        const want = clients.get(id);
        const got = sha256(secret);
        return crypto.timingSafeEqual(want, got) ? id : null;
    }

    /** POST {base}oauth/token: client credentials (RFC 6749 §4.4), with resource (RFC 8707). */
    function tokenEndpoint(req, res)
    {
        if (req.method !== 'POST') return tokenError(res, 405, 'invalid_request', 'the token endpoint takes POST');
        let text = '';
        req.on('data', (chunk) => { text += chunk; if (text.length > 8192) { text = ''; req.destroy(); } });
        req.on('end', () => {
            const form = new URLSearchParams(text);
            if (form.get('grant_type') === TOKEN_EXCHANGE) return exchangeEndpoint(res, form);
            if (form.get('grant_type') !== 'client_credentials') return tokenError(res, 400, 'unsupported_grant_type', 'this world issues tokens by client credentials and by token exchange');
            const client = clientOf(req, form);
            if (!client) return tokenError(res, 401, 'invalid_client');
            const resources = form.getAll('resource');
            if (resources.some((r) => r !== RESOURCE)) return tokenError(res, 400, 'invalid_target', 'this authorization server issues tokens for ' + RESOURCE + ' only');
            issueToken(client, { scope : form.has('scope') ? form.get('scope') : undefined, client_id : client })
                .then((token) => {
                    if (!token) return tokenError(res, 400, 'invalid_scope', 'no grant record of this world covers the scope asked for');
                    const claims = JSON.parse(fromB64u(token.split('.')[1]).toString('utf8'));
                    const body = JSON.stringify({ access_token : token, token_type : 'Bearer', expires_in : claims.exp - claims.iat, scope : claims.scope });
                    res.writeHead(200, { 'Content-Type' : 'application/json', 'Content-Length' : Buffer.byteLength(body), 'Cache-Control' : 'no-store', Pragma : 'no-cache' });
                    res.end(body);
                })
                .catch((e) => tokenError(res, 500, 'server_error', String(e && e.message || e)));
        });
    }

    /** The token endpoint's answer to a token exchange (RFC 8693 §2.1 and §2.2). */
    function exchangeEndpoint(res, form)
    {
        const targets = form.getAll('resource').concat(form.getAll('audience'));
        if (targets.some((r) => r !== RESOURCE)) return tokenError(res, 400, 'invalid_target', 'this authorization server issues tokens for ' + RESOURCE + ' only');
        if (form.has('requested_token_type') && form.get('requested_token_type') !== ACCESS_TOKEN_TYPE) return tokenError(res, 400, 'invalid_request', 'this world issues access tokens only');
        if (!form.get('subject_token') || !SUBJECT_TOKEN_TYPES.has(form.get('subject_token_type'))) return tokenError(res, 400, 'invalid_request', 'a token exchange names a subject_token, an access token, and its subject_token_type');
        if (!form.get('actor_token') || !SUBJECT_TOKEN_TYPES.has(form.get('actor_token_type'))) return tokenError(res, 400, 'invalid_request', 'this world exchanges tokens only for an acting party: name the actor_token and its actor_token_type');
        exchangeToken(form.get('subject_token'), form.get('actor_token'), form.has('scope') ? form.get('scope') : undefined)
            .then((out) => {
                if (out.error) return tokenError(res, 400, out.error, out.description);
                const body = JSON.stringify({ access_token : out.token, issued_token_type : ACCESS_TOKEN_TYPE, token_type : 'Bearer', expires_in : out.claims.exp - out.claims.iat, scope : out.claims.scope });
                res.writeHead(200, { 'Content-Type' : 'application/json', 'Content-Length' : Buffer.byteLength(body), 'Cache-Control' : 'no-store', Pragma : 'no-cache' });
                res.end(body);
            })
            .catch((e) => tokenError(res, 500, 'server_error', String(e && e.message || e)));
    }

    /**
     * A token exchange (DELEGATION above): { token, claims } or { error, description }. The actor token is this
     * world's own token for the acting party; the subject token is this world's, or a trusted issuer's.
     */
    async function exchangeToken(subjectToken, actorToken, scope)
    {
        const actorV = await verifyToken(actorToken);
        if (!actorV.ok) return { error : 'invalid_request', description : 'the actor token: ' + actorV.reason };
        if (actorV.actors.length) return { error : 'invalid_request', description : 'the actor token is itself a token issued by exchange' };
        const actor = actorV.claims.sub;
        const subjectV = await verifySubjectToken(subjectToken, actor);
        if (!subjectV.ok) return { error : 'invalid_request', description : 'the subject token: ' + subjectV.reason };
        const principal = currentParty(subjectV);
        const allowed = grantedScopesFor(actor, principal);
        if (!allowed.length) return { error : 'invalid_request', description : 'no grant record of this world lets ' + actor + ' act for ' + principal.sub };
        const asked = scope === undefined ? allowed : String(scope).split(' ').filter(Boolean);
        const scopes = policy.SCOPES.filter((s) => asked.includes(s) && allowed.includes(s));
        if (!scopes.length) return { error : 'invalid_scope', description : 'no grant record for acting covers the scope asked for' };
        const iat = Math.floor(now() / 1000);
        const exp = Math.min(iat + TTL_S, Math.floor(subjectV.claims.exp));
        const subIss = issuerOf(subjectV.claims);
        const act = Object.assign({ sub : actor }, subjectV.claims.act && !subjectV.foreign ? { act : subjectV.claims.act } : {});
        const claims = Object.assign({ iss : ISSUER, aud : RESOURCE, sub : subjectV.claims.sub }, subIss ? { sub_iss : subIss } : {}, { client_id : actor, act, scope : scopes.join(' '), iat, exp, jti : crypto.randomBytes(12).toString('hex') });
        return { token : await signClaims(claims), claims };
    }

    /** The bearer token of a request's Authorization header, '' for none, null for a header that is not a bearer token. */
    function bearerOf(req)
    {
        const raw = req.headers.authorization;
        if (raw === undefined || String(raw).trim() === '') return '';
        const m = BEARER.exec(String(raw));
        return m ? m[1] : null;
    }

    /** Whether a request URL carries a token (RFC 6750 §2.3, which this world does not accept). */
    function tokenInUrl(url)
    {
        return url.searchParams.has('access_token');
    }

    /**
     * The check of one request (see THE CHECK above). Calls next() when the request may go on, with
     * req.oslAuth = { subject, scopes, presence }; otherwise answers it. The request body is held while the token is
     * verified, so the handler that runs next still reads all of it.
     */
    function gate(req, res, next)
    {
        const url = new URL(req.url, 'http://127.0.0.1');
        const raw = url.pathname;
        const read = req.method === 'GET' || req.method === 'HEAD';
        if (read && raw === PRM_PATH) return sendMeta(req, res, resourceMetadata());
        if (read && raw === AS_PATH) return sendMeta(req, res, serverMetadata());
        let p = raw;
        if (basePath)
        {
            if (raw !== basePath && !raw.startsWith(basePath + '/')) return next();
            p = raw.slice(basePath.length) || '/';
        }
        if (req.method === 'OPTIONS') return next();
        if (tokenInUrl(url)) return refuse(req, res, 400, 'invalid_request', null, 'a token is never accepted in a URL; send it in the Authorization header');
        if (p === TOKEN_PATH) return tokenEndpoint(req, res);
        const need = policy.needOf(req.method, p);
        if (!need) return next();
        const token = bearerOf(req);
        if (token === '') return refuse(req, res, 401, null, need);
        if (token === null) return refuse(req, res, 401, 'invalid_token', need, 'the Authorization header carries no bearer token');
        req.pause();
        verifyToken(token).then((verified) => {
            if (!verified.ok) { req.resume(); return refuse(req, res, 401, 'invalid_token', need, verified.reason); }
            if (!covers(verified, need)) { req.resume(); note(req, p, verified, 'refused'); return refuse(req, res, 403, 'insufficient_scope', need, 'no grant of this world covers ' + need.scope + (need.resource === 'users' ? ' of its User resources' : '')); }
            if (need.ownUser !== undefined && owners.get(String(need.ownUser)) !== verified.claims.sub) { req.resume(); note(req, p, verified, 'refused'); return refuse(req, res, 403, 'insufficient_scope', need, 'a visitor may remove only its own User'); }
            note(req, p, verified, 'allowed');
            req.oslAuth = { subject : verified.claims.sub, scopes : verified.scopes.slice(), presence : presenceOf(verified) };
            next();
            req.resume();
        }).catch((e) => { req.resume(); refuse(req, res, 401, 'invalid_token', need, 'the token could not be checked: ' + String(e && e.message || e)); });
    }

    /** The User a join made belongs to its visitor: only that visitor's DELETE may remove it. */
    function ownUser(userId, subject)
    {
        if (userId !== undefined && userId !== null && subject) owners.set(String(userId), subject);
    }

    /**
     * A stream's first message, checked: { ok, subject, verified } or { ok: false, reason } (invalid_token or
     * insufficient_scope).
     */
    async function authorizeStream(text)
    {
        let message = null;
        try { message = JSON.parse(text); } catch (e) { message = null; }
        if (!message || message.type !== 'auth' || typeof message.token !== 'string') return { ok : false, reason : 'invalid_token: the first message carries no access token' };
        const verified = await verifyToken(message.token);
        if (!verified.ok) return { ok : false, reason : 'invalid_token: ' + verified.reason };
        if (!covers(verified, policy.STREAM_NEED)) return { ok : false, reason : 'insufficient_scope: no observe grant of this world' };
        return { ok : true, subject : verified.claims.sub, verified };
    }

    /**
     * Watch an authorized stream: onLost(reason) is called once when the holder's observe grant is withdrawn or
     * lapses, or the token expires. Returns stop().
     */
    function watchStream(verified, onLost)
    {
        let done = false;
        const check = () => {
            if (done) return;
            let reason = null;
            if (!(now() / 1000 < verified.claims.exp)) reason = 'the token has expired';
            else if (!covers(verified, policy.STREAM_NEED)) reason = 'the observe grant was withdrawn';
            if (reason) { stop(); onLost(reason); }
        };
        const unlisten = grants.onChange(check);
        const timer = setInterval(check, WATCH_MS);
        if (timer.unref) timer.unref();
        function stop() { done = true; unlisten(); clearInterval(timer); }
        return stop;
    }

    /** How a stream's holder sees what the world sends: every event and snapshot, with people only under the presence grant. */
    function streamView(verified)
    {
        return {
            presence : () => presenceOf(verified),
            event : (evt) => (presenceOf(verified) ? evt : policy.anonymousEvent(evt)),
            state : (snapshot) => (presenceOf(verified) ? snapshot : policy.withoutPeople(snapshot)),
        };
    }

    /** A value of a path that shows people, as this request's reader may see it. */
    function peopleView(req, value)
    {
        return req.oslAuth && req.oslAuth.presence ? value : policy.withoutPeople(value);
    }
    /** A Web of Worlds answer (a Node, the nodes a POST made), as this request's reader may see the people it places. */
    function placementsView(req, value)
    {
        return req.oslAuth && req.oslAuth.presence ? value : policy.withoutPlacedPeople(value);
    }
    /** The World resource, as this request's reader may see it. */
    function worldView(req, world)
    {
        return req.oslAuth && req.oslAuth.presence ? world : policy.worldWithoutPeople(world);
    }

    return {
        required : true,
        resource : RESOURCE,
        issuer : ISSUER,
        metadataPath : PRM_PATH,
        tokenEndpoint : TOKEN_ENDPOINT,
        grants,
        trust,
        decisions : () => log.map((d) => Object.assign({}, d, { actors : d.actors.slice() })),
        publicKey : publicKeyHex,
        exchangeToken,
        grantedScopes,
        grantedScope,
        issueToken,
        verifyToken,
        gate,
        tokenInUrl,
        ownUser,
        authorizeStream,
        watchStream,
        streamView,
        peopleView,
        placementsView,
        worldView,
        resourceMetadata,
    };
}

module.exports = { createWorldAuth, authMode, createGrantStore, createTrustStore, MODES, TOKEN_EXCHANGE, ACCESS_TOKEN_TYPE };
