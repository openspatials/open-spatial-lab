'use strict';

/*
 * The world's side of the identity handshake (iteration 5, stage A). server.js serves it: GET /wow/world adds
 * worldFields(), POST /wow/user calls join(), GET /wow/user/{id} reads user(), DELETE /wow/user/{id} depart(),
 * GET /osl/handshake/record/{id} record().
 *
 * A world that declares a handshake (cfg.handshake) states in its World resource:
 *   identity  { base }   the base URL it stands behind, from its own configuration, never from a request;
 *   claims    [{ name, required, issuers? }]   what it asks a visitor for at entry; `issuers`, when present,
 *             means the claim counts only when one of those issuers signed it;
 *   issues    [credential type]   what it issues (empty until stage B).
 *
 * POST {base}wow/user takes { manifest, proof } and answers with the outcome:
 *   - the integrity check: the manifest's signature verifies against its subject (a did:key);
 *   - the holder proof: signed by that same subject, over the manifest's digest, with this world's base URL
 *     as the audience, a nonce this world has not seen, and a time within the last two minutes;
 *   - each claim the world asked for is satisfied (with its trust level: self-asserted or issuer-verified)
 *     or not (with the reason); claims it did not ask for are not read. A value of the wrong shape is not
 *     satisfied ("malformed"). A claim is issuer-verified only when this world lists the issuer of its
 *     credential; any other credential (the visitor's own key, or a key this world does not list) leaves
 *     it self-asserted, because anyone can make a key and sign;
 *   - the outcome rule (iteration 5 order, ID1): a required claim not satisfied gives "deny"; otherwise an
 *     optional claim not satisfied gives "proceed-in-part"; otherwise "proceed". A failed integrity check
 *     or holder proof gives "deny" with the reason.
 * Every outcome is recorded (UC04-R06). The record keeps the outcome and the claims the answer names, and
 * no pointer, nonce or signature of the visitor. A proceed creates a User whose name, AvatarURI and
 * preferences are what the visitor disclosed and the world accepted, and sends user_joined on the event stream
 * (deps.emitEvent). Its id comes from the world's one User id allocator (deps.nextUserId), which presence uses too, so
 * a handshake user and a presence user never share an id. count() is the number of handshake users present; the World's
 * users.active_user_count includes it. depart() ends that User's visit: the User is no longer present, user_left goes on the stream
 * once, and the record of the join stays.
 *
 * The `preferences` claim holds optional members (PREFERENCE_MEMBERS, provisional names): at least one known
 * member, each of its shape; a member the lab does not know is ignored. When it is accepted, the answer and
 * the record carry `osl_preferences_applied`: every member received, true when this world applied it (the lab
 * applies preferred_height_m), false otherwise. No received member is left out of it.
 *
 * The pilot statement (User.pilot): every join carries `pilot`, what the visitor states about who is at the controls
 * (human, agent or hybrid; PILOTS). This world copies it onto the User it makes and never supplies one: a join without
 * a pilot statement, or with another value, gives "deny" with the reason, like a failed holder proof (every claim
 * asked for is listed as not satisfied with that reason), and is recorded. It is the visitor's statement, not proof
 * of who is at the controls.
 *
 * The manifest and holder-proof shapes are the lab's own proposal (web/wow-handshake.mjs).
 */

const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const WEB = path.join(__dirname, '..', '..', '..', 'web');
const MAX_AGE_MS = 2 * 60 * 1000;
const FUTURE_SKEW_MS = 30 * 1000;

let modules = null;
async function load()
{
    if (!modules)
    {
        const signing = await import(pathToFileURL(path.join(WEB, 'signing', 'index.mjs')).href);
        const shared = await import(pathToFileURL(path.join(WEB, 'wow-handshake.mjs')).href);
        modules = { signing, shared };
    }
    return modules;
}

function sameBase(a, b)
{
    try
    {
        const norm = (u) => { const x = new URL(u); x.search = ''; x.hash = ''; if (!x.pathname.endsWith('/')) x.pathname += '/'; return x.href; };
        return norm(a) === norm(b);
    }
    catch (e) { return false; }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isHttpUrl(s)
{
    try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch (e) { return false; }
}

const isBool = (v) => typeof v === 'boolean';

/** The pilot statements a join may carry (User.pilot): who the visitor states is at the controls. web/wow-handshake.mjs names the same. */
const PILOTS = Object.freeze(['human', 'agent', 'hybrid']);
const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** A well-formed BCP 47 language tag (RFC 5646 langtag, or a private-use tag; irregular grandfathered tags are not accepted). */
const BCP47 = /^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}|[A-Za-z]{4,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-[Xx](?:-[A-Za-z0-9]{1,8})+)?|[Xx](?:-[A-Za-z0-9]{1,8})+)$/;

/**
 * The members of the `preferences` claim the lab knows, each optional, with its shape (provisional names; the
 * accessibility members are a placeholder vocabulary). web/wow-handshake.mjs names the same members.
 */
const PREFERENCE_MEMBERS = Object.freeze({
    preferred_height_m : isPositive,
    language : (v) => typeof v === 'string' && BCP47.test(v),
    captions : isBool,
    reduced_motion : isBool,
    seated : isBool,
    text_scale : isPositive,
    input : (v) => Array.isArray(v) && v.every((m) => typeof m === 'string' && m.trim().length > 0),
    reduced_flashing : isBool,
});
/** The members this lab world applies. It reports every other member it receives as not applied. */
const PREFERENCES_APPLIED = Object.freeze(['preferred_height_m']);

const knownPreferences = (v) => Object.keys(v).filter((k) => Object.prototype.hasOwnProperty.call(PREFERENCE_MEMBERS, k));

/** At least one known member, each of its shape; unknown members are ignored. */
function preferencesOk(v)
{
    if (!isObject(v)) return false;
    const known = knownPreferences(v);
    if (known.length === 0) return false;
    return known.every((k) => PREFERENCE_MEMBERS[k](v[k]));
}

/**
 * The shapes of the claim values the lab knows (provisional names; no overlay defines them yet). A value of
 * another shape is not satisfied. A claim name the lab does not know takes any value.
 */
const SHAPES = {
    avatar : { ok : (v) => isObject(v) && typeof v.uri === 'string' && isHttpUrl(v.uri) && (v.label === undefined || typeof v.label === 'string'), expected : 'an object with an absolute http(s) uri' },
    display_name : { ok : (v) => typeof v === 'string' && v.trim().length > 0, expected : 'a non-empty string' },
    preferences : { ok : preferencesOk, expected : 'an object with at least one of ' + Object.keys(PREFERENCE_MEMBERS).join(', ') + ', each of its shape' },
    age : { ok : (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0, expected : 'a number of years' },
};

function createHandshake(cfg, deps)
{
    const spec = cfg && cfg.handshake;
    if (!spec) return null;
    deps = deps || {};
    const now = deps.now || (() => Date.now());
    const asked = (spec.claims || []).map((c) => ({
        name : String(c.name),
        required : c.required === true,
        ...(Array.isArray(c.issuers) ? { issuers : c.issuers.map(String) } : {}),
    }));
    const issues = (spec.issues || []).map(String);
    const records = [];
    const recordsById = new Map();
    const users = new Map();
    const seenNonces = new Map();
    // The world's one User id allocator, shared with presence (runtime.nextWowUserId).
    const nextUserId = deps.nextUserId;
    if (typeof nextUserId !== 'function') throw new Error('createHandshake needs deps.nextUserId, the world\'s one User id allocator');
    const emitEvent = typeof deps.emitEvent === 'function' ? deps.emitEvent : () => {};

    /** The World resource members this world adds. */
    function worldFields()
    {
        return {
            identity : { base : spec.base, ...(spec.label ? { label : spec.label } : {}) },
            claims : asked.map((c) => Object.assign({}, c, c.issuers ? { issuers : c.issuers.slice() } : {})),
            issues : issues.slice(),
        };
    }

    function rememberNonce(nonce, at)
    {
        for (const [n, t] of seenNonces) if (at - t > MAX_AGE_MS + FUTURE_SKEW_MS) seenNonces.delete(n);
        seenNonces.set(nonce, at);
    }

    /** The integrity check and the holder proof. Returns { ok, reason, subject }. */
    async function verifyPresentation(body, at)
    {
        const { signing, shared } = await load();
        const manifest = body && body.manifest;
        const proof = body && body.proof;
        if (!isObject(manifest) || !isObject(manifest.claims) || typeof manifest.subject !== 'string')
            return { ok : false, reason : 'no manifest with a subject and claims' };
        if (!manifest.subject.startsWith('did:key:'))
            return { ok : false, reason : 'the manifest subject is not a did:key' };
        // The integrity check: the manifest, as received, is what its subject signed.
        const integrity = await signing.verifyManifestProfileA(manifest, { didOrKey : manifest.subject });
        if (!integrity.ok) return { ok : false, reason : 'integrity check failed: ' + integrity.reason };
        // The holder proof.
        if (!isObject(proof) || proof.type !== shared.HOLDER_PROOF_TYPE) return { ok : false, reason : 'holder proof missing' };
        const held = await signing.verifyManifestProfileA(proof, { didOrKey : manifest.subject });
        if (!held.ok) return { ok : false, reason : 'holder proof failed: not signed by the manifest subject (' + held.reason + ')' };
        if (proof.manifest_digest !== await shared.manifestDigest(manifest)) return { ok : false, reason : 'holder proof failed: it was made for another manifest' };
        if (!sameBase(proof.audience, spec.base)) return { ok : false, reason : 'holder proof failed: it was made for ' + proof.audience + ', not this world' };
        const created = Date.parse(proof.created);
        if (!Number.isFinite(created) || at - created > MAX_AGE_MS || created - at > FUTURE_SKEW_MS)
            return { ok : false, reason : 'holder proof failed: it is not fresh' };
        // The pilot statement (User.pilot): stated by the visitor, never supplied by this world.
        if (body.pilot === undefined) return { ok : false, reason : 'no pilot statement (pilot: human, agent or hybrid)' };
        if (!PILOTS.includes(body.pilot)) return { ok : false, reason : 'pilot statement malformed: expected human, agent or hybrid' };
        if (typeof proof.nonce !== 'string' || proof.nonce.length < 22) return { ok : false, reason : 'holder proof failed: no nonce' };
        if (seenNonces.has(proof.nonce)) return { ok : false, reason : 'holder proof failed: its nonce was already used (a replay)' };
        rememberNonce(proof.nonce, at);
        return { ok : true, reason : null, subject : manifest.subject, pilot : body.pilot };
    }

    /** One asked claim: { satisfied, trust, reason }. Reads only claims the world asked for. */
    async function claimStatus(claim, manifest)
    {
        const { signing, shared } = await load();
        const entry = manifest.claims[claim.name];
        if (!isObject(entry) || entry.value === undefined) return { satisfied : false, reason : 'not sent' };
        const shape = SHAPES[claim.name];
        if (shape && !shape.ok(entry.value)) return { satisfied : false, reason : 'malformed: expected ' + shape.expected };
        let trust = shared.TRUST.SELF;
        let issuer = null;
        if (entry.credential !== undefined)
        {
            const c = entry.credential;
            if (!isObject(c) || c.type !== shared.CREDENTIAL_TYPE || typeof c.issuer !== 'string' || !c.issuer.startsWith('did:key:'))
                return { satisfied : false, reason : 'its credential is malformed' };
            const v = await signing.verifyManifestProfileA(c, { didOrKey : c.issuer });
            if (!v.ok) return { satisfied : false, reason : 'its credential does not verify (' + v.reason + ')' };
            if (c.subject !== manifest.subject || c.claim !== claim.name || JSON.stringify(c.value) !== JSON.stringify(entry.value))
                return { satisfied : false, reason : 'its credential was issued for another subject or value' };
            issuer = c.issuer;
            // Issuer-verified only when this world lists the issuer. Otherwise the claim stays self-asserted.
            if (claim.issuers && claim.issuers.indexOf(c.issuer) !== -1) trust = shared.TRUST.ISSUER;
        }
        if (claim.issuers && trust !== shared.TRUST.ISSUER)
            return { satisfied : false, trust, reason : issuer ? 'this world does not accept the issuer of ' + claim.name + '; the claim is ' + trust : 'this world requires an issuer for ' + claim.name + '; the claim is ' + trust };
        return { satisfied : true, trust };
    }

    function record(answer, extra)
    {
        const id = crypto.randomBytes(12).toString('hex');
        const rec = {
            id,
            at : new Date(now()).toISOString(),
            outcome : answer.outcome,
            ...(answer.reason ? { reason : answer.reason } : {}),
            satisfied : answer.satisfied.map((c) => Object.assign({}, c)),
            not_satisfied : answer.not_satisfied.map((c) => Object.assign({}, c)),
            ...(answer.osl_preferences_applied ? { osl_preferences_applied : Object.assign({}, answer.osl_preferences_applied) } : {}),
            ...(answer.user ? { user : answer.user } : {}),
            ...(extra || {}),
        };
        records.push(rec);
        recordsById.set(id, rec);
        return rec;
    }

    /** Handle one join. Returns { status, answer }. */
    async function join(body)
    {
        const at = now();
        const { shared } = await load();
        const presented = await verifyPresentation(body, at);
        let answer;
        if (!presented.ok)
        {
            answer = {
                outcome : shared.OUTCOME.DENY,
                reason : presented.reason,
                satisfied : [],
                not_satisfied : asked.map((c) => ({ name : c.name, required : c.required, reason : presented.reason })),
            };
        }
        else
        {
            const manifest = body.manifest;
            const satisfied = [];
            const notSatisfied = [];
            const accepted = {};
            for (const claim of asked)
            {
                const s = await claimStatus(claim, manifest);
                if (s.satisfied)
                {
                    satisfied.push({ name : claim.name, required : claim.required, trust : s.trust });
                    accepted[claim.name] = manifest.claims[claim.name].value;
                }
                else notSatisfied.push({ name : claim.name, required : claim.required, reason : s.reason, ...(s.trust ? { trust : s.trust } : {}) });
            }
            const requiredMissing = notSatisfied.filter((c) => c.required);
            const optionalMissing = notSatisfied.filter((c) => !c.required);
            let outcome = shared.OUTCOME.PROCEED;
            if (requiredMissing.length) outcome = shared.OUTCOME.DENY;
            else if (optionalMissing.length) outcome = shared.OUTCOME.PART;
            answer = { outcome, satisfied, not_satisfied : notSatisfied };
            if (outcome === shared.OUTCOME.DENY) answer.reason = 'required claim not satisfied: ' + requiredMissing.map((c) => c.name).join(', ');
            // Every preferences member received, and whether this world applied it: none is left out.
            if (isObject(accepted.preferences))
            {
                const applied = {};
                for (const member of Object.keys(accepted.preferences)) applied[member] = outcome !== shared.OUTCOME.DENY && PREFERENCES_APPLIED.includes(member);
                answer.osl_preferences_applied = applied;
            }
            if (outcome !== shared.OUTCOME.DENY)
            {
                const id = nextUserId();
                const user = { id };
                user.name = typeof accepted.display_name === 'string' ? accepted.display_name : 'visitor ' + id;
                user.pilot = presented.pilot;
                if (isObject(accepted.avatar) && typeof accepted.avatar.uri === 'string') user.AvatarURI = accepted.avatar.uri;
                if (isObject(accepted.preferences)) user.osl_preferences = JSON.parse(JSON.stringify(accepted.preferences));
                // Known members only on the User: a member the lab does not know is ignored.
                if (isObject(user.osl_preferences)) for (const k of Object.keys(user.osl_preferences)) if (!Object.prototype.hasOwnProperty.call(PREFERENCE_MEMBERS, k)) delete user.osl_preferences[k];
                users.set(id, user);
                answer.user = 'wow/user/' + id;
                emitEvent({ type : 'user_joined', user : Object.assign({}, user), urls : [ 'wow/user/' + id ] });
            }
        }
        // Claims sent that this world did not ask for are not read; the record notes only how many.
        const unasked = body && isObject(body.manifest) && isObject(body.manifest.claims)
            ? Object.keys(body.manifest.claims).filter((n) => !asked.some((c) => c.name === n)).length : 0;
        const rec = record(answer, unasked ? { unasked_claims_ignored : unasked } : null);
        answer.record = 'osl/handshake/record/' + rec.id;
        return { status : answer.outcome === shared.OUTCOME.DENY ? 403 : 201, answer };
    }

    /** A User who joined departs (DELETE /wow/user/{id}). Returns that User, or null for no such User. The record stays. */
    function depart(id)
    {
        const key = Number(id);
        const user = users.get(key);
        if (!user) return null;
        users.delete(key);
        emitEvent({ type : 'user_left', userId : key, user : { id : key, name : user.name }, urls : [ 'wow/user/' + key ] });
        return Object.assign({}, user);
    }

    return {
        worldFields,
        join,
        depart,
        user : (id) => (users.has(Number(id)) ? Object.assign({}, users.get(Number(id))) : null),
        count : () => users.size,
        record : (id) => (recordsById.has(id) ? JSON.parse(JSON.stringify(recordsById.get(id))) : null),
        records : () => JSON.parse(JSON.stringify(records)),
    };
}

module.exports = { createHandshake, MAX_AGE_MS, PREFERENCE_MEMBERS, PILOTS };
