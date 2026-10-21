/*
 * Web of Worlds CORE REQUIREMENTS: URL + hash-fragment semantics.
 *
 * UPSTREAM SOURCE (verbatim, do not paraphrase into code comments as if it said more):
 *   WoWAPI @ d39a1a0 — specification/OpenSpatialWorld/README.md
 *   § "Core Requirements and Feature"
 *     "Open continuous spatial experience and session for a given device and User-Agent/browser (UA)"
 *
 *     | Requirements  | Feature                            | Description                                             |
 *     | Join world    | URL, URL#join, URL#join=aspect.id  | join the world as new or existing user on a given       |
 *     |               |                                    | device and UA                                           |
 *     | Follow world  | URL#follow, URL#follow=aspect.id   | follow the world as new or existing user                |
 *     | Preview world | URL#preview, #preview=aspect.id    | experence world without                    <-- TRUNCATED UPSTREAM
 *     | Persist world | store or bookmark URL              |                                            <-- no description cell
 *     | Share world   | send URL to second user            |                                            <-- no description cell
 *
 * THE POINT, AND WHY OSL MISSED IT: these are NOT an API. They are plain URL and
 * hash-fragment semantics. A world IS a URL. You JOIN it by visiting it. You FOLLOW or
 * PREVIEW it with a fragment. You PERSIST it by bookmarking it. You SHARE it by sending it.
 * There is no endpoint here to implement. OSL implemented the § "Optional Feature" half
 * (/wow/world, /wow/user/{id}, /wow/scene|spatial/...) because that half is the OpenAPI file,
 * and never noticed this half existed. Before this module, nothing in the codebase read
 * location.hash at all.
 *
 * This module is PURE: no DOM, no fetch, no globals. It turns a URL string into a normalised
 * intent. The caller (web/index.html boot hook) applies it. Keeping it pure is what makes the
 * grammar provable by load-independent unit tests rather than by a flaky browser run.
 *
 * ---------------------------------------------------------------------------------------
 * READ-ONLY ON THE URL — a hard constraint inherited.
 * app.js documents it: params are "read once at boot from location.search and never
 * written", because Puppeteer counts history.pushState/replaceState as a main-frame
 * `framenavigated`, which breaks the no-reload proof's nav-count==1 guard. So this module
 * only ever PARSES and BUILDS strings. It never assigns location.hash, never pushes history.
 * Persist and Share need only that the URL be stable and restorable — not that we write it.
 * ---------------------------------------------------------------------------------------
 *
 * EVERY INTERPRETATION IS LABELLED `INTERPRETATION:` BELOW, WITH ITS REASONING. The spec is
 * thin, one row is literally truncated mid-sentence, and it contradicts its own API.yaml
 * (README says /wow/scene/, API.yaml says /wow/spatial/). Where we had to choose a reading we
 * say so. We never invent spec text. These labels are lifted into the spec-coverage UI
 * and shown to WoW authors as OUR readings, so they are written to be
 * defensible, not convenient.
 */

'use strict';

/** The three intents the fragment grammar can express. Spec-stated verbs. */
export const WOW_INTENT = Object.freeze({
    JOIN    : 'join',
    FOLLOW  : 'follow',
    PREVIEW : 'preview',
});

const KNOWN_INTENTS = new Set([ WOW_INTENT.JOIN, WOW_INTENT.FOLLOW, WOW_INTENT.PREVIEW ]);

/**
 * Spec-stated: the Join row lists bare `URL` as a Join feature. So a URL with NO fragment is
 * a join. This is the one default the spec gives us outright.
 */
export const DEFAULT_INTENT = WOW_INTENT.JOIN;

/*
 * INTERPRETATION #1 — "aspect.id" is a PLACEHOLDER for an aspect's identifier, not the
 * literal string "aspect.id".
 * REASONING: the § Optional Feature section addresses "aspects of the world (e.g user
 * avatar)" as `URL/wow/user/4182` — 4182 being a concrete aspect id — and describes
 * /wow/world as returning "live aspects". The table's other cells are concrete literals
 * (`#join`), so the dotted `aspect.id` reads as object.field, i.e. "the id of an aspect".
 * Both readings converge on the same thing: the value after `=` is an aspect's identifier.
 */

/*
 * INTERPRETATION #2 — an ASPECT is any addressable sub-element of the world that the spec's
 * own Optional Feature section exposes by URL: a user/avatar (`/wow/user/{id}`) and a scene
 * node (`/wow/scene/node`, which API.yaml spells `/wow/spatial/{spatialID}/node/{nodeId}`).
 * REASONING: the spec calls those exact resources "aspects" ("Read and write aspects of the
 * world ... e.g user avatar") and /wow/world advertises "live aspects". We therefore resolve
 * an aspect.id against those two id-spaces. We do NOT invent a third.
 * GAP: the spec never defines the aspect id SYNTAX (opaque? typed? namespaced?), never says
 * whether ids are unique across kinds, and never says what a client should do when an
 * aspect.id does not resolve. We accept an optional `kind/` qualifier and fall back to
 * probing the known kinds; see resolveAspect().
 */

/** Aspect kinds OSL can address. Derived from the spec's Optional Feature resources. */
export const ASPECT_KIND = Object.freeze({
    USER : 'user',   // spec: URL/wow/user/4182       ("aspects of the world (e.g user avatar)")
    NODE : 'node',   // spec: URL/wow/scene/node      (API.yaml: /wow/spatial/{spatialID}/node/{nodeId})
});

/**
 * OSL's worlds. Each is a distinct 041 backend; the frontend origin proxies them.
 * The `w` path segment is the world's stable, bookmarkable, spec-composable URL space
 * (see worldUrlFor / wowApiBase below).
 */
export const OSL_WORLDS = Object.freeze({
    lobby : Object.freeze({ key : 'lobby', apiBase : '/api/lobby', label : 'Lobby' }),
    a     : Object.freeze({ key : 'a',     apiBase : '/api/a',     label : 'Location A' }),
    b     : Object.freeze({ key : 'b',     apiBase : '/api/b',     label : 'Location B' }),
});

/** Legacy OSL entry: ?role=source|target|player already selects a world. Keep it working. */
export const ROLE_TO_WORLD = Object.freeze({
    source : 'a',
    target : 'b',
    player : 'lobby',
});

/**
 * The world a bare origin URL means when nothing else selects one.
 *
 * This MIRRORS the app's own pre-existing rule and must not drift from it: app.js defaults
 * role=source, and live-adapter's endpointKeyForRole('source', undefined) resolves to backend
 * 'a'. (An earlier draft of this module said 'lobby' here, which would have made the module
 * quietly disagree with the app about which world a bare URL means.)
 */
export const DEFAULT_WORLD = 'a';

/**
 * Parse a hash fragment into a WoW intent.
 *
 * Grammar (spec-stated):
 *   ""                  -> join      (bare `URL` is listed as a Join feature)
 *   "#join"             -> join
 *   "#join=<aspect>"    -> join at aspect
 *   "#follow"           -> follow
 *   "#follow=<aspect>"  -> follow aspect
 *   "#preview"          -> preview
 *   "#preview=<aspect>" -> preview aspect
 *
 * @param {string} fragment - with or without the leading '#'
 * @returns {{intent:string, aspectId:string|null, recognized:boolean, bare:boolean, raw:string, reason:string|null}}
 */
export function parseWowFragment(fragment)
{
    const raw = String(fragment == null ? '' : fragment);
    const body = raw.startsWith('#') ? raw.slice(1) : raw;

    // Bare URL (no fragment) — spec-stated Join.
    if (body === '')
    {
        return {
            intent     : DEFAULT_INTENT,
            aspectId   : null,
            recognized : true,
            bare       : true,
            raw,
            reason     : null,
        };
    }

    /*
     * INTERPRETATION #3 — the fragment is a SINGLE `verb[=value]` token, and the verb is
     * matched case-insensitively.
     * REASONING: the spec shows exactly one verb per URL and never shows a separator, a
     * repeated verb, or a compound fragment, so we do not invent a compound grammar. We accept
     * mixed case (`#Join`) because URL fragments are routinely hand-typed and hand-shared, and
     * being liberal in what we accept costs nothing and cannot collide (there are three verbs
     * and no case-distinct meanings). We are strict in what we EMIT: buildWorldUrl always
     * writes lowercase.
     * GAP: the spec does not state case sensitivity, nor whether a compound fragment
     * (`#join&follow`) is legal. We reject compounds as unrecognized rather than guess.
     */
    const m = /^([A-Za-z]+)(?:=([\s\S]*))?$/.exec(body);
    if (!m)
    {
        return unrecognized(raw, 'fragment is not a `verb` or `verb=value` token');
    }

    const verb = m[1].toLowerCase();
    if (!KNOWN_INTENTS.has(verb))
    {
        /*
         * INTERPRETATION #4 — an UNRECOGNIZED fragment is NOT a WoW intent, and must not be
         * hijacked. We fall back to the bare-URL reading (join) and flag recognized:false so
         * the caller can leave ordinary anchor behaviour (`#section-2`, `#about`) completely
         * alone.
         * REASONING: the spec says a bare `URL` joins. Visiting `URL#some-anchor` is still
         * visiting URL, so the join reading survives; but an anchor is not a WoW verb, and a
         * client that swallowed every fragment would break every non-WoW use of the fragment
         * on the same page. Flagging rather than throwing keeps a WoW client and an ordinary
         * web page coexisting on one URL.
         */
        return unrecognized(raw, `"${verb}" is not a WoW intent verb (join|follow|preview)`);
    }

    // `#join=` (empty value) is the verb with no aspect — an empty string is not an id.
    let aspectId = null;
    if (m[2] !== undefined)
    {
        let value = m[2];
        try { value = decodeURIComponent(value); }
        catch (_) { /* malformed %-escape: keep the raw text rather than throw */ }
        value = value.trim();
        if (value !== '') aspectId = value;
    }

    return {
        intent     : verb,
        aspectId,
        recognized : true,
        bare       : false,
        raw,
        reason     : null,
    };
}

function unrecognized(raw, reason)
{
    return {
        intent     : DEFAULT_INTENT, // interpretation #4: still a visit, so still a join
        aspectId   : null,
        recognized : false,
        bare       : false,
        raw,
        reason,
    };
}

/*
 * INTERPRETATION #5 — THE LOAD-BEARING ONE. Which intents register PRESENCE (a session /
 * a user in the world), and which do not.
 *
 *   join    -> presence REGISTERED     (spec-stated: "join the world as new or existing user")
 *   follow  -> presence REGISTERED     (INTERPRETED)
 *   preview -> presence NOT REGISTERED (INTERPRETED — the spec sentence is truncated)
 *
 * REASONING for preview: the Preview row's description reads, in full, in the upstream file:
 * "experence world without" — and stops. The sentence is truncated mid-clause upstream. The
 * only reading that (a) completes the clause naturally, (b) makes Preview a DISTINCT row from
 * Join, and (c) explains why the other two rows both say "as new or existing user" while this
 * one conspicuously does not, is: experience the world WITHOUT JOINING it — i.e. without a
 * session, without registering as a user, without presence. That is the reading we implement.
 * We state plainly that the words "without joining" are OURS, not the spec's.
 *
 * REASONING for follow: the Follow row's description DOES say "as new or existing user" —
 * the same words as Join. So Follow is not the no-session mode; Preview is. Follow is a real
 * user whose VIEWPOINT is attached to something rather than freely driven — which is also the
 * only thing the word "follow" can distinguish, and the only thing `#follow=aspect.id` (follow
 * a specific aspect, e.g. another user's avatar) can mean. So Follow registers presence AND
 * sets a follow-target.
 * ALTERNATIVE READING WE REJECTED: "follow" as in social-media subscribe (no presence,
 * receive updates). We rejected it because it would make Follow's description ("as new or
 * existing user") a lie, and would make Follow and Preview near-duplicates while leaving the
 * "without" in Preview unexplained.
 * GAP: the spec never says what a follower's viewpoint does when the followed aspect leaves
 * the world, nor whether a follower is visible to others. We register the follower as an
 * ordinary present user (visible), and fall back to a free camera if the target disappears.
 */
export function intentRegistersPresence(intent)
{
    return intent === WOW_INTENT.JOIN || intent === WOW_INTENT.FOLLOW;
}

/**
 * INTERPRETATION #6 — bare `#follow` (no aspect) follows THE WORLD, not a specific aspect.
 * REASONING: the row is titled "Follow world", and the aspect form is the optional variant.
 * With no aspect there is nothing to attach to, so we register presence and track the world's
 * live state with a free camera — i.e. behave as a join that is FLAGGED as following, so the
 * UI can show it and so a followTarget can be attached later without a reload.
 * GAP: the spec does not say what following a world (rather than an aspect) does.
 */
export function followTargetFor(parsed)
{
    if (parsed.intent !== WOW_INTENT.FOLLOW) return null;
    return parsed.aspectId || null; // null => follow the world itself (interpretation #6)
}

/**
 * Resolve an aspect.id to the spec's own Optional-Feature resources.
 *
 * Accepts an optional `kind/` qualifier (`user/avatar-local-001`, `node/portal-1`) — OSL's
 * own addition for disambiguation — or a bare id, in which case we return the candidate paths
 * in priority order for the caller to probe.
 *
 * NOTE THE UPSTREAM SELF-CONTRADICTION: README.md § Optional Feature says `URL/wow/scene/` and
 * `URL/wow/scene/node`; API.yaml (the same repo, the same spec) says
 * `/wow/spatial/{spatialID}` and `/wow/spatial/{spatialID}/node/{nodeId}`. They disagree. OSL
 * serves the API.yaml spelling (/wow/spatial/...), which is the machine-readable, generated,
 * and testable one. We emit the API.yaml spelling and record the contradiction as a gap.
 *
 * @param {string|null} aspectId
 * @param {{spatialId?:string}} [opts]
 * @returns {{kind:string|null, id:string|null, qualified:boolean, candidates:string[]}}
 */
export function resolveAspect(aspectId, opts = {})
{
    if (!aspectId) return { kind : null, id : null, qualified : false, candidates : [] };

    const spatialId = opts.spatialId || null;
    const slash = String(aspectId).indexOf('/');

    if (slash > 0)
    {
        const kind = aspectId.slice(0, slash).toLowerCase();
        const id = aspectId.slice(slash + 1);
        if (kind === ASPECT_KIND.USER && id)
            return { kind : ASPECT_KIND.USER, id, qualified : true, candidates : [ `/wow/user/${enc(id)}` ] };
        if (kind === ASPECT_KIND.NODE && id && spatialId)
            return { kind : ASPECT_KIND.NODE, id, qualified : true, candidates : [ `/wow/spatial/${enc(spatialId)}/node/${enc(id)}` ] };
        if (kind === ASPECT_KIND.NODE && id)
            return { kind : ASPECT_KIND.NODE, id, qualified : true, candidates : [] }; // needs a spatialId to address
    }

    // Unqualified: probe the known aspect id-spaces, users first (the spec's own example).
    const id = String(aspectId);
    const candidates = [ `/wow/user/${enc(id)}` ];
    if (spatialId) candidates.push(`/wow/spatial/${enc(spatialId)}/node/${enc(id)}`);
    return { kind : null, id, qualified : false, candidates };
}

function enc(s) { return encodeURIComponent(String(s)); }

/**
 * The world's URL space. A world IS a URL — so each OSL world gets a stable path.
 *
 * INTERPRETATION #7 — a world's URL must be a PATH prefix (origin + path), not a query
 * string, and OSL's world URL is `/w/{worldKey}`.
 * REASONING: the spec composes the Optional-Feature resources onto the world URL by simple
 * path concatenation — "URL/wow/world", "URL/wow/user/4182". That composition is only
 * well-defined if URL is an origin-or-path prefix: you cannot append "/wow/world" to
 * "http://host/?role=player" and get anything meaningful. OSL's pre-existing entry URLs were
 * query-based (`/index.html?role=player`), which is exactly why no OSL origin answered
 * `URL/wow/world` (gap G-NEW-1). We therefore mount each world at a path prefix, under which
 * `/wow/*` resolves by the spec's own concatenation rule. The legacy query form still works
 * and still resolves to the same world (see parseWorldUrl), so nothing that exists breaks.
 */
export function worldUrlFor(origin, worldKey)
{
    const key = normalizeWorldKey(worldKey) || DEFAULT_WORLD;
    // THE TRAILING SLASH IS LOad-BEARING. A page served at `/w/a` (no slash) resolves its
    // relative imports against `/w/` — so `app.js` becomes `/w/app.js` and 404s. Served at
    // `/w/a/`, they resolve correctly. The canonical world URL therefore always ends in `/`;
    // src/serve.js 301-redirects the slashless form onto it.
    return `${stripTrailingSlash(origin)}/w/${key}/`;
}

/**
 * Spec composition: the world's WoW API base is the world URL + "/wow".
 * This is what a conforming WoW client does with our URL: GET <worldUrl>/wow/world.
 */
export function wowApiBase(worldUrl)
{
    return `${stripTrailingSlash(worldUrl)}/wow`;
}

function stripTrailingSlash(s) { return String(s || '').replace(/\/+$/, ''); }

function normalizeWorldKey(k)
{
    const key = String(k || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(OSL_WORLDS, key) ? key : null;
}

/**
 * Parse a full world URL (origin + path + query + fragment) into everything the client needs.
 *
 * Recognises, in priority order:
 *   1. the spec-composable path form   /w/{world}[/...]
 *   2. the legacy OSL query form       ?role=source|target|player   (and ?world={key})
 *   3. otherwise the default world
 *
 * @param {string} href - an absolute URL (e.g. location.href)
 * @param {{spatialId?:string}} [opts]
 * @returns {object} normalised intent
 */
export function parseWorldUrl(href, opts = {})
{
    const u = new URL(String(href));

    // --- which world? ---
    let worldKey = null;
    let worldSource = 'default';

    const pathMatch = /^\/w\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (pathMatch)
    {
        const k = normalizeWorldKey(decodeURIComponent(pathMatch[1]));
        if (k) { worldKey = k; worldSource = 'path'; }
    }

    if (!worldKey)
    {
        /*
         * LEGACY OSL ENTRY. This MIRRORS the app's own rules exactly — app.js's role default
         * plus live-adapter's endpointKeyForRole(role, active) — so the module can never
         * disagree with the app about which world a legacy URL means. Precedence:
         *   ?active=  >  ?role= (player => lobby)  >  role default (source => a)
         */
        const active = String(u.searchParams.get('active') || '').toLowerCase();
        const roleParam = String(u.searchParams.get('role') || '').toLowerCase();
        const stage = [ '1', 'true' ].includes(String(u.searchParams.get('stage') || '').toLowerCase());
        const role = roleParam === 'target' ? 'target'
            : (roleParam === 'player' || (!roleParam && stage)) ? 'player'
                : 'source';

        if (active === 'target' || active === 'b') { worldKey = 'b'; worldSource = 'query:active'; }
        else if (active === 'source' || active === 'a') { worldKey = 'a'; worldSource = 'query:active'; }
        else if (active === 'lobby') { worldKey = 'lobby'; worldSource = 'query:active'; }
        else if (role === 'player') { worldKey = 'lobby'; worldSource = 'query:role'; }
        else if (role === 'target') { worldKey = 'b'; worldSource = 'query:role'; }
        else { worldKey = DEFAULT_WORLD; worldSource = roleParam ? 'query:role' : 'default'; }
    }

    // --- which intent? ---
    const frag = parseWowFragment(u.hash);
    const aspect = resolveAspect(frag.aspectId, opts);

    const worldUrl = worldUrlFor(u.origin, worldKey);

    return {
        // world
        world       : worldKey,
        worldSource,
        worldUrl,                                   // stable + bookmarkable + shareable
        apiBase     : OSL_WORLDS[worldKey].apiBase, // the existing same-origin backend proxy
        wowApiBase  : wowApiBase(worldUrl),         // spec composition: <worldUrl>/wow

        // intent
        intent      : frag.intent,
        aspectId    : frag.aspectId,
        aspect,
        recognized  : frag.recognized,
        bare        : frag.bare,
        reason      : frag.reason,

        // the consequence — interpretation #5
        registersPresence : intentRegistersPresence(frag.intent),
        followTarget      : followTargetFor(frag),

        // Persist: the URL to store/bookmark to return to exactly this world+aspect+intent.
        persistUrl  : buildWorldUrl(worldUrl, { intent : frag.intent, aspectId : frag.aspectId }),
    };
}

/**
 * Serialise a world URL + intent back to a string. Used for Persist (bookmark) and Share
 * (send to a second user). Always emits the lowercase canonical form.
 *
 * INTERPRETATION #8 — the PERSIST/SHARE url carries the fragment, so that restoring or
 * sharing returns you to the same world AND the same aspect AND the same mode.
 * REASONING: the Persist row says "store or bookmark URL" and the Share row "send URL to
 * second user" — in both cases the artefact is *the URL*, and a URL includes its fragment. The
 * task's own acceptance test is that pasting it back returns you to the same world and aspect,
 * which is only true if the aspect travels in the URL. A bare-origin bookmark would satisfy
 * neither.
 * NOTE: a bare join emits the CLEAN url with no fragment (not `#join`) — the spec lists bare
 * `URL` as a Join feature, so the cleanest URL that round-trips is the bare one.
 */
export function buildWorldUrl(worldUrl, { intent = DEFAULT_INTENT, aspectId = null } = {})
{
    // Canonical form keeps the trailing slash (see worldUrlFor) so the emitted URL is one a
    // browser can actually load without a redirect.
    const base = `${stripTrailingSlash(worldUrl)}/`;
    const verb = KNOWN_INTENTS.has(intent) ? intent : DEFAULT_INTENT;

    if (verb === DEFAULT_INTENT && !aspectId) return base;           // bare URL == join
    if (!aspectId) return `${base}#${verb}`;
    return `${base}#${verb}=${encodeURIComponent(aspectId)}`;
}

/**
 * The complete, machine-readable interpretation ledger. Exported so the spec-coverage UI
 * can render OUR readings to WoW authors without re-deriving them, and
 * so a reviewer can diff them against the spec.
 */
export const WOW_CORE_INTERPRETATIONS = Object.freeze([
    Object.freeze({
        id : 'I1', subject : '"aspect.id" is a placeholder, not a literal',
        spec_says : 'URL#join=aspect.id',
        we_read : 'the value after "=" is an aspect identifier',
        reasoning : '§ Optional Feature addresses a concrete aspect as /wow/user/4182 and /wow/world advertises "live aspects"; the other cells are concrete literals, so aspect.id reads as object.field.',
    }),
    Object.freeze({
        id : 'I2', subject : 'what an aspect IS',
        spec_says : '"Read and write aspects of the world ... (e.g user avatar)" -> /wow/user/4182; "expose parts of scene" -> /wow/scene/node',
        we_read : 'an aspect is a user/avatar (/wow/user/{id}) or a scene node (/wow/spatial/{id}/node/{nodeId})',
        reasoning : 'those are the only resources the spec itself calls aspects. We invent no third id-space.',
        gap : 'aspect id SYNTAX is never defined (opaque? typed? unique across kinds?), and the spec never says what to do when an aspect.id does not resolve.',
    }),
    Object.freeze({
        id : 'I3', subject : 'fragment is a single verb[=value] token; verb matched case-insensitively',
        spec_says : 'URL#join, URL#join=aspect.id',
        we_read : 'exactly one verb per URL; #Join == #join; compound fragments are not WoW intents',
        reasoning : 'the spec never shows a separator or a repeated verb. Liberal in what we accept, strict in what we emit (always lowercase).',
        gap : 'case sensitivity and compound fragments are unspecified.',
    }),
    Object.freeze({
        id : 'I4', subject : 'unrecognized fragments are not hijacked',
        spec_says : '(nothing)',
        we_read : '#some-anchor is not a WoW intent: fall back to the bare-URL join reading and flag recognized:false so ordinary anchor behaviour is untouched',
        reasoning : 'visiting URL#anchor is still visiting URL (so the join reading survives), but swallowing every fragment would break every non-WoW use of the fragment on the same page.',
    }),
    Object.freeze({
        id : 'I5', subject : 'PREVIEW registers no presence; FOLLOW does — THE LOAD-BEARING READING',
        spec_says : 'Preview: "experence world without" [TRUNCATED MID-SENTENCE UPSTREAM]. Follow: "follow the world as new or existing user". Join: "join the world as new or existing user".',
        we_read : 'preview = experience the world WITHOUT JOINING it: no session, no presence registration. follow = a real user (presence registered) whose viewpoint is attached to an aspect.',
        reasoning : 'The Preview clause is cut off upstream. The only reading that completes it naturally, keeps Preview distinct from Join, and explains why Join and Follow BOTH say "as new or existing user" while Preview conspicuously does not, is "without joining". Follow keeps the user wording, so Follow is not the no-session mode — Preview is.',
        rejected_alternative : 'follow = social-media subscribe (no presence). Rejected: it would make Follow\'s own description ("as new or existing user") false, would near-duplicate Preview, and would leave Preview\'s "without" unexplained.',
        gap : 'the words "without joining" are OURS. The spec sentence stops at "without".',
    }),
    Object.freeze({
        id : 'I6', subject : 'bare #follow (no aspect) follows the WORLD',
        spec_says : 'URL#follow',
        we_read : 'register presence and track the world with a free camera — a join FLAGGED as following, so a follow-target can attach later without a reload',
        reasoning : 'the row is titled "Follow world"; with no aspect there is nothing to attach to.',
        gap : 'the spec does not say what following a world (rather than an aspect) does.',
    }),
    Object.freeze({
        id : 'I7', subject : 'a world URL is a PATH prefix; OSL mounts worlds at /w/{world}',
        spec_says : 'URL/wow/world, URL/wow/user/4182',
        we_read : 'the world URL must be an origin-or-path prefix, because the spec composes the optional resources onto it by plain path concatenation',
        reasoning : 'you cannot append "/wow/world" to "http://host/?role=player" and get anything meaningful. OSL\'s legacy entry URLs were query-based, which is precisely why no OSL origin answered URL/wow/world (gap G-NEW-1). The legacy query form still resolves to the same world, so nothing breaks.',
    }),
    Object.freeze({
        id : 'I8', subject : 'the persisted/shared URL carries the fragment',
        spec_says : 'Persist: "store or bookmark URL". Share: "send URL to second user".',
        we_read : 'the bookmarked/shared URL includes its fragment, so restoring or sharing returns the same world AND aspect AND mode; a bare join emits the clean fragment-less URL',
        reasoning : 'in both rows the artefact is *the URL*, and a URL includes its fragment. A URL that cannot be bookmarked back into the same state satisfies neither row.',
    }),
    Object.freeze({
        id : 'I9', subject : 'upstream self-contradiction: /wow/scene/ vs /wow/spatial/',
        spec_says : 'README.md § Optional Feature says URL/wow/scene/ and URL/wow/scene/node. API.yaml, in the SAME repo, says /wow/spatial/{spatialID} and /wow/spatial/{spatialID}/node/{nodeId}.',
        we_read : 'we emit and serve the API.yaml spelling (/wow/spatial/...)',
        reasoning : 'API.yaml is the machine-readable, generated and testable artefact, and is what OSL already serves. This is a CONTRADICTION IN THE SPEC, not an ambiguity — it needs an upstream fix, not a reading.',
        gap : 'UPSTREAM DEFECT: the prose spec and the OpenAPI file disagree on the scene/spatial path.',
    }),
    // I10 was TAKEN (it is what app.js:127 does — a
    // /w/{world} URL boots the embodied player role) and written up in the
    // result, but it never landed in this ledger. The spec-coverage panel renders
    // this array to WoW authors, so a reading that is missing here is a reading the
    // reader cannot see. Added, labelled, and pinned by stage-readiness-proof.js.
    Object.freeze({
        id : 'I10', subject : 'a /w/{world} URL is a WORLD ENTRY, so it boots the embodied player role',
        spec_says : '(nothing — the spec never says what role or embodiment a world entry starts in)',
        we_read : 'visiting a world URL means entering the world as an embodied player; an explicit ?role= still wins',
        reasoning : 'the Core Requirements say you JOIN a world by visiting its URL "as new or existing user". OSL\'s legacy ?role=source|target inspector windows are Open Spatial Lab observer views, not WoW world entries, so they must not be the default a WoW client lands in.',
        gap : 'the spec says nothing about roles, embodiment, or what a visitor IS on arrival.',
    }),
    // the OpenSpatialAsset + OpenUserManifest readings. Each
    // is DRIVEN OVER THE WIRE and negative-tested by src/wow-gaps-proof.mjs.
    Object.freeze({
        id : 'I11', subject : 'OpenSpatialAsset media types — API.yaml vs the README registration table disagree',
        spec_says : 'API.yaml GET / negotiates 21 model/* types (incl. model/vnd.collada+xml, model/vrml); the README\'s IANA table lists model/u3d but NOT those two, and marks las/glExtRef/SPZ as wanted-but-unregistered (😦).',
        we_read : 'negotiate the API.yaml set (the machine-readable artifact wins, same rule as I9) and ALSO accept model/u3d because the README registers it; carry the 😦 unregistered column verbatim.',
        reasoning : 'the count 21 is DERIVED, not quoted: wow-media-types.js re-reads the upstream YAML and throws on any drift, so the transcription is re-checked rather than trusted. The two lists genuinely differ — a contradiction to declare, not silently reconcile.',
        gap : 'UPSTREAM DEFECT: the prose registration table and the OpenAPI content block are not the same set.',
    }),
    Object.freeze({
        id : 'I12', subject : 'an OpenSpatialAsset URL is a PATH PREFIX (the spec describes one asset per base URL)',
        spec_says : 'paths are `/` (HEAD/GET bytes) and `/wow/asset` (the Asset descriptor), rooted at an asset ORIGIN; the spec never says how a server hosting MANY assets addresses them.',
        we_read : 'the base is a path prefix — HEAD/GET / compose as /wow/asset/{assetId}/ and the descriptor as /wow/asset/{assetId}/wow/asset. No index endpoint is invented; a bare GET /wow/asset 404s.',
        reasoning : 'the same reading I7 took for world URLs, blessed by the spec\'s own server URL carrying a /v1 path segment. Discovery is by URL — the WoW premise — not by a catalogue the spec does not define.',
    }),
    Object.freeze({
        id : 'I13', subject : 'OpenSpatialAsset 403 vs 404 — a 404 may CONCEAL existence (spec text, not our liberty)',
        spec_says : '404 = "Element does not exist OR user does not have authorization to know whether this resource exists or not." 403 = "User does not have authorization to view this resource."',
        we_read : 'a restricted asset answers 403 (it is admitted to exist); a hidden asset answers 404 even though it exists (existence concealed). Both arms are exercised on REAL, live primitives, so both are provable on the wire.',
        reasoning : 'the existence-concealing 404 is the spec\'s own sentence; we implement both arms rather than pick one. Our authorization is a labelled local demo bearer token — enough to make 403/404 real, explicitly NOT an SSO integration.',
    }),
    Object.freeze({
        id : 'I14', subject : 'the OpenUserManifest base is a PATH PREFIX per user, at a SEPARATE origin',
        spec_says : 'the manifest is rooted at `/` of a manifest origin (server URL carries /v1); HEAD/GET / return one manifest; the spec never says how an origin serving many users addresses them.',
        we_read : 'the manifest lives at its OWN origin (a separate port — RFC 6454 makes that a distinct web origin) and composes as /v1/{userId}/; a world DEREFERENCES it instead of reading it inlined.',
        reasoning : 'same prefix reading as I7/I12; the separate origin is not hand-waved — the browser\'s own same-origin policy agrees a different port is a different origin. /wow/user STILL inlines the signed manifest (declared, versioned redundancy D10), so no existing client breaks.',
    }),
    Object.freeze({
        id : 'I15', subject : 'OpenUserManifest 302 is on GET only — a redirected manifest is un-HEAD-able',
        spec_says : 'API.yaml puts 302 "Resource is located elsewhere" on GET; HEAD declares only 200/403/404 and says "Redirects are not followed."',
        we_read : 'GET 302s to the location; HEAD answers 200 with the ETag OF THE POINTER (never a 302), because by the spec\'s own sentence a HEAD 302 would be read as unauthorized. We invent no code the spec does not list for HEAD.',
        reasoning : 'following the spec EXACTLY exposes a real hole: a relocated manifest cannot be HEAD-checked for freshness. Reported upstream. The asset pillar\'s elsewhere HEAD takes the same reading for the same reason.',
        gap : 'UPSTREAM DEFECT: HEAD has no way to express "located elsewhere", so a redirected resource is un-HEAD-able.',
    }),
]);

export default {
    WOW_INTENT,
    DEFAULT_INTENT,
    ASPECT_KIND,
    OSL_WORLDS,
    ROLE_TO_WORLD,
    DEFAULT_WORLD,
    parseWowFragment,
    parseWorldUrl,
    buildWorldUrl,
    worldUrlFor,
    wowApiBase,
    resolveAspect,
    intentRegistersPresence,
    followTargetFor,
    WOW_CORE_INTERPRETATIONS,
};
