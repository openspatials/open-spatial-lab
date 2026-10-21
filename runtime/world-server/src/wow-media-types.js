'use strict';

/*
 * OpenSpatialAsset: the NEGOTIATED MEDIA-TYPE VOCABULARY.
 *
 * TRANSCRIBED, VERBATIM AND BY HAND, from the open spec:
 *   WoWAPI@d39a1a0
 *   specification/OpenSpatialAsset/API.yaml  -> paths./.get.responses.200.content
 *   specification/OpenSpatialAsset/README.md -> "## Model type registration"
 *
 * 🔢 THE COUNT, DERIVED — NOT QUOTED.
 * `API.yaml` `GET /` negotiates **21** media types. Our own audit report said
 * "20" and the task said "21"; NEITHER was taken on trust. The list below is the
 * transcription, `SPEC_NEGOTIATED_MEDIA_TYPES.length` is the count, and
 * `assertSpecTranscriptionIsFaithful()` RE-DERIVES it from the upstream YAML on
 * disk and THROWS if our list and the spec's list differ by a single entry. A
 * transcription nobody re-derives is a rumour.
 *
 * 🔎 AND THE SPEC DISAGREES WITH ITSELF (declared, not silently reconciled):
 * the API.yaml `content` block and the README's IANA-registration table are NOT
 * the same set.
 *   - in API.yaml but ABSENT from the README table:  model/vnd.collada+xml, model/vrml
 *   - in the README table but ABSENT from API.yaml:  model/u3d
 * We negotiate the API.yaml set (the machine-readable artifact wins — the same
 * rule took for the README-vs-API.yaml path contradiction, I9) and we
 * ALSO accept `model/u3d`, because the README explicitly registers it. Both
 * decisions are labelled interpretations (I11), never silent.
 *
 * 😦 THE UNREGISTERED WANTS. The README's table tracks THREE model types it wants
 * and CANNOT have, marked with a frowning face because IANA has not registered
 * them: `las`, `glExtRef`, `SPZ`. We carry that column verbatim. It is the
 * proof, in upstream's own hand, that OpenSpatialAsset's media-type list is a
 * LIVING registry with KNOWN HOLES — which is exactly the door our upstream note
 * walks through when it proposes a signed-document type.
 */

const fs = require('fs');

/**
 * The 21 media types `GET /` negotiates, in the spec's own order.
 * Each entry: { mediaType, iana: true|false, ext, binary }
 * `ext` feeds Content-Disposition (the spec's declared fallback when
 * Content-Type is absent: "The file extension will be used as a hint to select
 * an appropriate loader").
 */
const SPEC_NEGOTIATED_MEDIA_TYPES = Object.freeze([
    { mediaType : 'model/3mf', iana : true, ext : '3mf', binary : true },
    { mediaType : 'model/e57', iana : true, ext : 'e57', binary : true },
    { mediaType : 'model/gltf-binary', iana : true, ext : 'glb', binary : true },
    { mediaType : 'model/gltf+json', iana : true, ext : 'gltf', binary : false },
    { mediaType : 'model/JT', iana : true, ext : 'jt', binary : true },
    { mediaType : 'model/iges', iana : true, ext : 'iges', binary : true },
    { mediaType : 'model/mtl', iana : true, ext : 'mtl', binary : false },
    { mediaType : 'model/obj', iana : true, ext : 'obj', binary : false },
    { mediaType : 'model/prc', iana : true, ext : 'prc', binary : true },
    { mediaType : 'model/step', iana : true, ext : 'step', binary : true },
    { mediaType : 'model/step+xml', iana : true, ext : 'stpx', binary : false },
    { mediaType : 'model/step+zip', iana : true, ext : 'stpz', binary : true },
    { mediaType : 'model/step-xml+zip', iana : true, ext : 'stpxz', binary : true },
    { mediaType : 'model/stl', iana : true, ext : 'stl', binary : false },
    // ⚠ in API.yaml, ABSENT from the README's registration table (declared, I11).
    { mediaType : 'model/vnd.collada+xml', iana : true, ext : 'dae', binary : false },
    { mediaType : 'model/vnd.usda', iana : true, ext : 'usda', binary : false },
    { mediaType : 'model/vnd.usdz+zip', iana : true, ext : 'usdz', binary : true },
    // ⚠ in API.yaml, ABSENT from the README's registration table (declared, I11).
    { mediaType : 'model/vrml', iana : true, ext : 'wrl', binary : false },
    { mediaType : 'model/x3d-vrml', iana : true, ext : 'x3dv', binary : false },
    { mediaType : 'model/x3d+fastinfoset', iana : true, ext : 'x3db', binary : true },
    { mediaType : 'model/x3d+xml', iana : true, ext : 'x3d', binary : false },
]);

/**
 * README-ONLY: registered by IANA and listed in the README's table, but NOT in
 * the API.yaml `content` block. We accept it (the README registers it) and we
 * declare the asymmetry rather than pretending the two lists agree.
 */
const README_ONLY_MEDIA_TYPES = Object.freeze([
    { mediaType : 'model/u3d', iana : true, ext : 'u3d', binary : true },
]);

/**
 * 😦 The README's own WANTED-BUT-UNREGISTERED column, verbatim. These have NO
 * IANA media type — upstream marks each with a frowning face. We do not invent
 * media types for them; we carry the fact that they are missing.
 */
const WANTED_BUT_UNREGISTERED = Object.freeze([
    Object.freeze({ name : 'las', iana : false, note : 'LAS point cloud — upstream wants it; IANA has not registered it (😦).' }),
    Object.freeze({ name : 'glExtRef', iana : false, note : 'glTF External Reference — upstream wants it; IANA has not registered it (😦).' }),
    Object.freeze({ name : 'SPZ', iana : false, note : 'Niantic SPZ gaussian splats — upstream wants it; IANA has not registered it (😦).' }),
]);

/**
 * 🚩 PROVISIONAL AND UNREGISTERED — OURS, NOT THE SPEC'S. `application/msf+jws`
 * is NOT an IANA media type and is NOT in OpenSpatialAsset. It is declared
 * divergence D8 and it is the exact hole this pillar has: OpenSpatialAsset is
 * media-type-PLURAL and signed-document-BLIND — 21 negotiated types and not one
 * of them carries a signature, an integrity claim, or an executable module.
 *
 * We serve our real signed fabric under this label so the gap is CONCRETE on the
 * wire rather than rhetorical in a note. It is never presented as canonical: it
 * is absent from SPEC_NEGOTIATED_MEDIA_TYPES, it is flagged `provisional:true`
 * on every Asset descriptor that offers it, and it earns no conformance flip.
 */
const PROVISIONAL_MEDIA_TYPES = Object.freeze([
    {
        mediaType : 'application/msf+jws', iana : false, ext : 'msf', binary : true, provisional : true,
        note : 'PROVISIONAL, UNREGISTERED, OURS (D8). No such IANA media type exists. OpenSpatialAsset '
            + 'negotiates 21 model/* types and has NO signed-document type; this label is what we propose '
            + 'upstream. Serving it here makes the proposal an implementer\'s, not a '
            + 'bystander\'s. It does NOT make us conformant — nothing does; there is no conformance suite.',
    },
]);

/** Everything the server will negotiate over: spec + README-only + provisional. */
const ALL_MEDIA_TYPES = Object.freeze(
    SPEC_NEGOTIATED_MEDIA_TYPES.concat(README_ONLY_MEDIA_TYPES, PROVISIONAL_MEDIA_TYPES)
        .map(entry => Object.freeze(entry)));

const BY_MEDIA_TYPE = new Map(ALL_MEDIA_TYPES.map(entry => [ entry.mediaType.toLowerCase(), entry ]));

function mediaTypeInfo(mediaType)
{
    return BY_MEDIA_TYPE.get(String(mediaType || '').toLowerCase()) || null;
}

/**
 * RE-DERIVE the transcription from the upstream YAML and THROW on any drift.
 *
 * This is the drift guard. It does NOT grep our own file for our own list (the
 * house defect class — a claim backed by a grep of itself). It reads the spec
 * off disk, extracts the media types under `paths./.get.responses.200.content`,
 * and compares SETS. Add a type upstream, or lose one here, and this throws.
 *
 * Returns { count, spec_count, missing, extra, source } on success.
 * Returns { skipped: true, reason } if the upstream clone is not on this machine
 * (the backend must still boot on a machine without the research tree) — the
 * VERIFIER (src/wow-gaps-proof.mjs) treats a skip as a hard FAIL, so the
 * guard can never be quietly skipped where it matters.
 */
function assertSpecTranscriptionIsFaithful(specYamlPath)
{
    const p = typeof specYamlPath === 'string' && specYamlPath ? specYamlPath : null;
    if (!p)
        return { skipped : true, reason : 'explicit upstream WoWAPI schema path not provided' };
    if (!fs.existsSync(p))
        return { skipped : true, reason : 'explicit upstream WoWAPI schema path not found' };

    const text = fs.readFileSync(p, 'utf8');
    // The `content:` block under `GET /` -> media types are keys indented 12 spaces.
    // Stop at the next path (`  /wow/asset:`) so `/wow/asset`'s JSON content is excluded.
    const getBlock = text.slice(
        text.indexOf('    get:'),
        text.indexOf('  /wow/asset:') === -1 ? text.length : text.indexOf('  /wow/asset:'));
    const found = [];
    const re = /^ {12}([A-Za-z0-9][\w.+-]*\/[\w.+-]+):\s*$/gm;
    let m;
    while ((m = re.exec(getBlock)) !== null) found.push(m[1]);

    const ours = SPEC_NEGOTIATED_MEDIA_TYPES.map(e => e.mediaType);
    const oursSet = new Set(ours.map(s => s.toLowerCase()));
    const specSet = new Set(found.map(s => s.toLowerCase()));
    const missing = found.filter(s => !oursSet.has(s.toLowerCase()));   // spec has, we lack
    const extra = ours.filter(s => !specSet.has(s.toLowerCase()));      // we have, spec lacks

    if (found.length === 0)
        throw new Error('wow-media-types: DRIFT GUARD BROKEN — extracted ZERO media types from ' + p
            + '. The guard is measuring nothing; fix the extractor before trusting any count.');
    if (missing.length || extra.length || found.length !== ours.length)
        throw new Error('wow-media-types: TRANSCRIPTION DRIFT vs ' + p
            + ' — spec negotiates ' + found.length + ', we transcribe ' + ours.length
            + '; spec-has-we-lack=[' + missing.join(', ') + ']'
            + '; we-have-spec-lacks=[' + extra.join(', ') + ']');

    return { count : ours.length, spec_count : found.length, missing, extra, source : p };
}

// ---------------------------------------------------------------------------
// RFC 7231 §5.3.2 (RFC 2616 §14.1) — Accept parsing + proactive negotiation.
//
// The spec's Multi-format Core Requirement is literally "Single- und Multi-format
// requests WITH AND WITHOUT content negotiation". Both branches are implemented:
//   - WITHOUT: no Accept header (or `*/*`) -> the asset's DEFAULT representation.
//   - WITH:    a real Accept header -> q-weighted, specificity-ordered selection,
//              `type/*` and `*/*` wildcards, explicit `q=0` refusal, and 406 when
//              nothing on offer is acceptable.
// ---------------------------------------------------------------------------

/** Parse an Accept header into ranges, most-preferred first. */
function parseAccept(headerValue)
{
    const raw = String(headerValue == null ? '' : headerValue).trim();
    if (!raw) return [];
    const ranges = [];
    for (const part of raw.split(',')) {
        const bits = part.trim().split(';');
        const range = bits.shift();
        if (!range) continue;
        const slash = range.indexOf('/');
        if (slash === -1) continue;
        const type = range.slice(0, slash).trim().toLowerCase();
        const subtype = range.slice(slash + 1).trim().toLowerCase();
        if (!type || !subtype) continue;
        let q = 1;
        for (const param of bits) {
            const eq = param.indexOf('=');
            if (eq === -1) continue;
            if (param.slice(0, eq).trim().toLowerCase() !== 'q') continue;
            const parsed = Number(param.slice(eq + 1).trim());
            if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed));
        }
        // RFC 7231 §5.3.2 precedence: exact type/subtype > type/* > */*
        const specificity = type === '*' ? 0 : (subtype === '*' ? 1 : 2);
        ranges.push({ type, subtype, q, specificity });
    }
    return ranges;
}

/** Does `range` match `mediaType`? */
function rangeMatches(range, mediaType)
{
    const slash = mediaType.indexOf('/');
    const type = mediaType.slice(0, slash).toLowerCase();
    const subtype = mediaType.slice(slash + 1).toLowerCase();
    if (range.type === '*' && range.subtype === '*') return true;
    if (range.type !== type) return false;
    return range.subtype === '*' || range.subtype === subtype;
}

/**
 * Proactive negotiation over `offers` (media-type strings, in the asset's own
 * preference order — the first is the asset's default).
 *
 * Returns { mediaType, q, negotiated, reason } or
 *         { mediaType: null, reason: 'not_acceptable', ... }  -> the caller 406s.
 */
function negotiate(acceptHeader, offers)
{
    const list = Array.isArray(offers) ? offers.filter(Boolean) : [];
    if (!list.length) return { mediaType : null, q : 0, negotiated : false, reason : 'no_representations' };

    const ranges = parseAccept(acceptHeader);
    // WITHOUT content negotiation: no (or empty) Accept -> the asset's default.
    if (!ranges.length)
        return { mediaType : list[0], q : 1, negotiated : false, reason : 'no_accept_header_default_representation' };

    let best = null;
    for (const offer of list) {
        // The most specific matching range wins; among equal specificity, the
        // highest q. A matching range with q=0 is an EXPLICIT REFUSAL of that
        // representation and removes it from consideration (RFC 7231 §5.3.1).
        let chosen = null;
        for (const range of ranges) {
            if (!rangeMatches(range, offer)) continue;
            if (!chosen
                || range.specificity > chosen.specificity
                || (range.specificity === chosen.specificity && range.q > chosen.q))
                chosen = range;
        }
        if (!chosen || chosen.q <= 0) continue;
        const candidate = { mediaType : offer, q : chosen.q, specificity : chosen.specificity };
        if (!best
            || candidate.q > best.q
            || (candidate.q === best.q && candidate.specificity > best.specificity))
            best = candidate;
    }

    if (!best)
        return {
            mediaType : null, q : 0, negotiated : true, reason : 'not_acceptable',
            offered : list.slice(),
        };
    return {
        mediaType : best.mediaType, q : best.q, negotiated : true,
        reason : 'content_negotiated', offered : list.slice(),
    };
}

module.exports = {
    SPEC_NEGOTIATED_MEDIA_TYPES,
    README_ONLY_MEDIA_TYPES,
    WANTED_BUT_UNREGISTERED,
    PROVISIONAL_MEDIA_TYPES,
    ALL_MEDIA_TYPES,
    SPEC_NEGOTIATED_COUNT : SPEC_NEGOTIATED_MEDIA_TYPES.length,
    mediaTypeInfo,
    assertSpecTranscriptionIsFaithful,
    parseAccept,
    negotiate,
};
