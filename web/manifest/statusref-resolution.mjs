// v0.4 statusRef revocation resolution.
//
// Owns the EVAL-18 revocation-AWARE path (EXT-OPT §O2 "statusRef Resolution
// Schema", named in Base §3.4) and strengthens RP1 bar R9 ("fail-closed
// everywhere; honest receipt denials") with a live revocation story. Browser-
// safe (no Node built-ins); the standalone Node driver that PROVES it against
// the external spec surface is verify.mjs.
//
// External source of truth (READ-ONLY):
//   - spec/v0.4/schema.json  $defs.statusRefResponse (the O2.2 wire shape) and
//                            $defs.signatureV04 (signature.statusRef URI +
//                            signature.revocationCursor)
//   - spec/v0.4/CONFORMANCE.md §2.18 (EVAL-18): resolve + record revocationStatus,
//                            else MUST report "unchecked" and MUST NOT claim
//                            revocation-aware conformance.
//   - docs/spec-v0.4 EXT-OPT §O2.1 resolution procedure · §O2.2 response schema ·
//                            §O2.3 status semantics · §O2.4 error handling ·
//                            §O2.5 endpoint conformance.
//   - spec/v0.2/SIGNATURE-PROFILE.md §5.2 (revocation-aware extension: resolve
//                            when statusRef present; revocationCursor prevents
//                            stale-status acceptance; undeterminable AND policy
//                            requires active ⇒ MUST reject).
//   - packages/universal-manifest reference: assertStatusRefResponseV04 (invalid
//                            status rejected) + the resolveRevocation callback
//                            path (suspended ⇒ accepted-with-warnings).
//
// THERE IS NO expected.json FIXTURE for statusRef. Acceptance is SPEC-SURFACE:
// a spec-conformant status-endpoint response SCHEMA (§O2.2) + the resolution
// dispositions (§O2.3) + the R9 fail-closed behavior. verify.mjs proves
// the schema against the ACTUAL schema.json and the reference validator, and
// drives the dispositions through the REAL reference evaluator (interop), which
// is the strongest proof available in the absence of a fixture.
//
// HONESTY CEILING (never overclaimed):
//   - The status authority here is a demo-local / mock resolver (in-memory,
//     synchronous, labeled). It is NOT a live external status service. It is
//     honest because every response it emits is §O2.2-schema-conformant and the
//     dispositions match §O2.3 / the reference callback path.
//   - Under the RP1 R9 policy (`active-required`, the demo default), any status
//     that is not confirmed `active` DENIES fail-closed: revoked, suspended,
//     unreachable, offline, malformed, cursor-regression, manifestId-mismatch,
//     and non-HTTPS statusRef all reject. No flag is flipped unless earned.
//   - The `spec-default` policy mirrors §O2.3 / the reference exactly (suspended
//     ⇒ accepted-with-warnings; unreachable ⇒ unchecked, not a reject) so the
//     two policies are honestly distinguished, not conflated.
//   - No `um_conformance` flag is flipped by this module (see feature_CONFORMANCE).

// ===========================================================================
// 0) Vocabulary — the O2.2 closed enum, the receipt revocationStatus set, and
//    the reason codes (spec/reference codes vs demo-local markers are labeled).
// ===========================================================================

/** schema.json $defs.statusRefResponse.status — the CLOSED O2.2 enum. */
export const STATUS_REF_STATUSES = Object.freeze(["active", "revoked", "suspended"]);

/** UmRevocationStatus (receipt) — the O2.2 enum PLUS "unchecked" (§2.18). */
export const REVOCATION_STATUSES = Object.freeze(["active", "revoked", "suspended", "unchecked"]);

/** The two policy modes this module implements (see the module header). */
export const STATUSREF_POLICIES = Object.freeze(["active-required", "spec-default"]);

// Reason codes that are SPEC / REFERENCE vocabulary (used by the reference v0.4
// evaluator and/or named verbatim in EXT-OPT §O2.4). Kept byte-identical.
export const REASON_REVOKED = "um:reason:status:revoked"; // §O2.3 + reference
export const REASON_SUSPENDED = "um:reason:status:suspended"; // §O2.3 + reference
export const REASON_UNCHECKED = "um:reason:status:unchecked"; // §2.18 + reference
export const REASON_ENDPOINT_UNKNOWN_MANIFEST = "um:reason:status:endpoint-unknown-manifest"; // §O2.4 (404)
export const REASON_ENDPOINT_UNAVAILABLE = "um:reason:status:endpoint-unavailable"; // §O2.4 (503/network)
export const REASON_OFFLINE = "um:reason:status:offline"; // §O2.4 (offline mode)

// DEMO-LOCAL markers (NOT in the reference reason registry). They exist to make
// the fail-closed cause auditable on the demo receipt; they are labeled here so
// nobody mistakes them for shipped spec vocabulary.
export const REASON_ENDPOINT_ERROR_PREFIX = "um:reason:status:endpoint-error"; // §O2.4 "other 4xx/5xx" (code appended)
export const REASON_MALFORMED = "um:reason:status:malformed-response"; // response fails $defs.statusRefResponse
export const REASON_CURSOR_REGRESSION = "um:reason:status:cursor-regression"; // §5.2/§O2.1 stale-status floor breached
export const REASON_MANIFEST_ID_MISMATCH = "um:reason:status:manifest-id-mismatch"; // §O2.2 manifestId MUST match @id
export const REASON_INSECURE_TRANSPORT = "um:reason:status:insecure-transport"; // §O2.1 non-HTTPS ⇒ treat as unreachable
export const REASON_ACTIVE_REQUIRED_DENIED = "um:reason:status:active-required-denied"; // R9 policy: not-active ⇒ deny

/** The demo status-endpoint URI convention (labeled demo-local, not a real host). */
export const DEMO_STATUS_ORIGIN = "https://status.demo.local/manifests/";

// ===========================================================================
// 1) §O2.2 response-schema validation — mirrors the reference
//    assertStatusRefResponseV04 EXACTLY (manifestId non-empty string; status in
//    the closed enum; updatedAt an RFC 3339 date-time). Plus a non-throwing form.
// ===========================================================================

// Same RFC 3339 date-time shape the reference validator uses (dist assertIsoDateTime).
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoDateTime(value) {
  return typeof value === "string" && value.length > 0 && RFC3339_DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Assert `value` is a valid statusRef response per EXT-OPT §O2.2. Throws with a
 * message mirroring the reference validator. `manifestId`, `status`, `updatedAt`
 * are REQUIRED; `reason`/`cursor`/`nextCheck` are OPTIONAL and unconstrained here
 * (schema.json allows additionalProperties). Kept byte-faithful to the reference
 * so verify.mjs can cross-check the two agree on every vector.
 */
export function assertStatusRefResponseV04(value) {
  if (!value || typeof value !== "object") throw new Error("StatusRef response must be an object");
  const obj = value;
  if (typeof obj.manifestId !== "string" || obj.manifestId.length === 0) {
    throw new Error("StatusRef response missing manifestId");
  }
  if (!STATUS_REF_STATUSES.includes(obj.status)) {
    throw new Error("StatusRef response status must be one of active|revoked|suspended");
  }
  if (!isIsoDateTime(obj.updatedAt)) {
    throw new Error("statusRef.updatedAt must be an ISO date-time");
  }
}

/** Non-throwing companion — returns { valid, errors[] }. */
export function validateStatusRefResponse(value) {
  try {
    assertStatusRefResponseV04(value);
    return { valid: true, errors: [] };
  } catch (e) {
    return { valid: false, errors: [e.message] };
  }
}

/**
 * Construct a §O2.2-schema-conformant status-endpoint response body. This is the
 * exact wire shape a conformant status endpoint (§O2.5) MUST return. `reason`,
 * `cursor`, `nextCheck` are included only when supplied (all OPTIONAL in §O2.2).
 */
export function buildStatusEndpointResponse({ manifestId, status, updatedAt, reason, cursor, nextCheck } = {}) {
  if (typeof manifestId !== "string" || manifestId.length === 0) throw new Error("buildStatusEndpointResponse: manifestId required");
  if (!STATUS_REF_STATUSES.includes(status)) throw new Error(`buildStatusEndpointResponse: status must be one of ${STATUS_REF_STATUSES.join("|")}`);
  const body = { manifestId, status, updatedAt: updatedAt || new Date().toISOString() };
  if (reason !== undefined) body.reason = reason;
  if (cursor !== undefined) body.cursor = cursor;
  if (nextCheck !== undefined) body.nextCheck = nextCheck;
  // Self-check: never emit a body that fails the very schema we claim to serve.
  assertStatusRefResponseV04(body);
  return body;
}

// ===========================================================================
// 2) Cursor monotonicity (§5.2 #2 / §O2.1 "revocationCursor is the issuance-time
//    floor"). Cursors are OPAQUE in the spec; the demo uses ONE deterministic
//    order so the stale-status floor can be demonstrated: compare a trailing
//    integer if BOTH carry one (e.g. "v3" ⇒ 3), else compare lexicographically.
// ===========================================================================

function cursorRank(cursor) {
  if (typeof cursor !== "string" || cursor.length === 0) return null;
  const m = cursor.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/** Returns -1 / 0 / 1 for a<b / a==b / a>b under the demo-local order. */
export function compareCursor(a, b) {
  const ra = cursorRank(a);
  const rb = cursorRank(b);
  if (ra !== null && rb !== null) return ra < rb ? -1 : ra > rb ? 1 : 0;
  // Fall back to opaque-string lexicographic comparison.
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ===========================================================================
// 3) Resolution client — §O2.1 procedure + §O2.4 error handling. Maps a status
//    endpoint outcome to a UmRevocationStatus ('active'|'revoked'|'suspended'|
//    'unchecked') and a reason. "Unresolvable" (unreachable / offline / malformed
//    / cursor-regression / id-mismatch / non-HTTPS) resolves to 'unchecked' + the
//    §O2.4 reason — the POLICY layer (§4) decides whether unchecked denies.
//
//    The endpoint is modeled as a transport result { httpStatus, body } (or a
//    thrown/absent transport ⇒ network failure), so the same logic serves the
//    in-memory demo authority AND, if wired, a real fetch().
// ===========================================================================

/**
 * @param {object} args
 * @param {string} args.statusRef          - signature.statusRef URI (§O2.1: MUST be https)
 * @param {string} [args.manifestId]       - the manifest @id (for the §O2.2 manifestId-match check)
 * @param {string} [args.revocationCursor] - signature.revocationCursor (issuance-time floor)
 * @param {string} [args.lastSeenCursor]   - a previously accepted cursor (cache floor; replay defense)
 * @param {(ref:string)=>({httpStatus:number, body?:object}|null)} args.transport
 *        - resolves the statusRef to a transport result. Return { httpStatus:0 }
 *          or null (or throw) to model a network failure; { httpStatus:503 } for
 *          unavailable; { httpStatus:404 } for unknown manifest; { httpStatus:200,
 *          body } for a served response. `offline:true` on the result ⇒ offline mode.
 * @returns {{revocationStatus:string, reason:(string|null), httpStatus:number, response:(object|null)}}
 */
export function resolveStatus({ statusRef, manifestId, revocationCursor, lastSeenCursor, transport } = {}) {
  const unchecked = (reason, httpStatus = 0, response = null) => ({ revocationStatus: "unchecked", reason, httpStatus, response });

  // §O2.1: https only. A non-HTTPS statusRef MUST be treated as unreachable.
  if (typeof statusRef !== "string" || !/^https:\/\//i.test(statusRef)) {
    return unchecked(REASON_INSECURE_TRANSPORT, 0, null);
  }
  if (typeof manifestId !== "string" || manifestId.length === 0) {
    return unchecked(REASON_MANIFEST_ID_MISMATCH, 0, null);
  }

  // Transport (§O2.1 GET). Any thrown/absent transport ⇒ network failure (§O2.4).
  let result;
  try {
    result = transport ? transport(statusRef) : null;
  } catch {
    result = null;
  }
  if (!result) return unchecked(REASON_ENDPOINT_UNAVAILABLE, 0, null);
  if (result.offline) return unchecked(REASON_OFFLINE, 0, null);

  const httpStatus = Number(result.httpStatus) || 0;

  // §O2.4 error handling — evaluators MUST NOT reject solely for unreachability;
  // they record "unchecked" with the classified reason. The POLICY layer decides.
  if (httpStatus === 0) return unchecked(REASON_ENDPOINT_UNAVAILABLE, 0, null); // network failure
  if (httpStatus === 404) return unchecked(REASON_ENDPOINT_UNKNOWN_MANIFEST, 404, null);
  if (httpStatus === 503) return unchecked(REASON_ENDPOINT_UNAVAILABLE, 503, null);
  if (httpStatus !== 200) {
    return unchecked(`${REASON_ENDPOINT_ERROR_PREFIX}:${httpStatus}`, httpStatus, null);
  }

  // 200 OK — parse + validate the §O2.2 response schema. Malformed ⇒ unresolvable.
  const body = result.body;
  const v = validateStatusRefResponse(body);
  if (!v.valid) return unchecked(REASON_MALFORMED, httpStatus, body ?? null);

  // §O2.2: manifestId MUST match the manifest's @id (§O2.5 keys the response).
  if (manifestId !== undefined && body.manifestId !== manifestId) {
    return unchecked(REASON_MANIFEST_ID_MISMATCH, httpStatus, body);
  }

  // §5.2 #2 / §O2.1: revocationCursor is the issuance-time floor; a response
  // whose cursor is STRICTLY BELOW the floor is stale/replayed ⇒ refuse it. The
  // higher of the issuance floor and any cached cursor is the effective floor.
  let floor = revocationCursor;
  if (lastSeenCursor !== undefined && (floor === undefined || compareCursor(lastSeenCursor, floor) > 0)) {
    floor = lastSeenCursor;
  }
  if (floor !== undefined) {
    if (typeof body.cursor !== "string" || body.cursor.length === 0 || compareCursor(body.cursor, floor) < 0) {
      return unchecked(REASON_CURSOR_REGRESSION, httpStatus, body);
    }
  }

  // §O2.3 status semantics — the response status IS the revocationStatus.
  return { revocationStatus: body.status, reason: null, httpStatus, response: body };
}

// ===========================================================================
// 4) Policy hook — maps a resolution to a disposition. TWO honest modes:
//
//    'spec-default'  — mirrors §O2.3 / the reference resolveRevocation path:
//       active    ⇒ accept
//       suspended ⇒ accepted-with-warnings + revocationStatus "suspended"
//       revoked   ⇒ rejected + revocationStatus "revoked"
//       unchecked ⇒ accept (§O2.4: MUST NOT reject SOLELY for unreachability),
//                   recording the §O2.4 reason as a warning.
//
//    'active-required' — the RP1 R9 fail-closed policy (§5.2 #3 "policy requires
//       active status" + §O2.6 default `deny` disposition). THE DEMO DEFAULT:
//       active    ⇒ accept
//       anything not confirmed active (suspended / revoked / unchecked) ⇒ DENY.
// ===========================================================================

/**
 * @param {{revocationStatus:string, reason:(string|null)}} resolution
 * @param {{policy?:string}} [opts]
 * @returns {{result:"accept"|"reject", outcome:string, revocationStatus:string, warnings:Array<{code:string,message:string}>}}
 */
export function applyRevocationPolicy(resolution, { policy = "active-required" } = {}) {
  if (!STATUSREF_POLICIES.includes(policy)) throw new Error(`applyRevocationPolicy: unknown policy "${policy}"`);
  const { revocationStatus, reason } = resolution;
  const warnings = [];
  const warn = (code, message) => warnings.push({ code, message });

  if (policy === "spec-default") {
    switch (revocationStatus) {
      case "active":
        return { result: "accept", outcome: "accepted", revocationStatus, warnings };
      case "suspended":
        warn(REASON_SUSPENDED, "Verify stage: manifest status is suspended (EXT-OPT §O2.3)");
        return { result: "accept", outcome: "accepted-with-warnings", revocationStatus, warnings };
      case "revoked":
        warn(REASON_REVOKED, "Verify stage: signature is revoked (EXT-OPT §O2.3)");
        return { result: "reject", outcome: "rejected", revocationStatus, warnings };
      case "unchecked":
      default:
        // §O2.4: MUST NOT reject solely because the endpoint is unreachable.
        warn(reason || REASON_UNCHECKED, "Verify stage: revocation status unchecked (EXT-OPT §O2.4)");
        return { result: "accept", outcome: "accepted-with-warnings", revocationStatus: "unchecked", warnings };
    }
  }

  // policy === "active-required" (RP1 R9 fail-closed)
  if (revocationStatus === "active") {
    return { result: "accept", outcome: "accepted", revocationStatus, warnings };
  }
  // Not confirmed active ⇒ DENY. Preserve revoked/suspended for the receipt;
  // an unresolvable status carries the §O2.4 reason plus the R9 denial marker.
  if (revocationStatus === "revoked") warn(REASON_REVOKED, "Verify stage: signature is revoked — active-required policy DENIES (R9)");
  else if (revocationStatus === "suspended") warn(REASON_SUSPENDED, "Verify stage: status suspended — not active ⇒ active-required policy DENIES (R9)");
  else warn(reason || REASON_UNCHECKED, "Verify stage: revocation status undeterminable — active-required policy DENIES fail-closed (§5.2 #3, R9)");
  warn(REASON_ACTIVE_REQUIRED_DENIED, "active-required policy: only a confirmed 'active' status may proceed");
  return { result: "reject", outcome: "rejected", revocationStatus, warnings };
}

/**
 * One-call resolution + policy → a receipt fragment. This is what the demo (and
 * an integrator) call: it composes §O2.1/§O2.4 resolution with the §4 policy.
 */
export function evaluateStatusRef({ statusRef, manifestId, revocationCursor, lastSeenCursor, transport, policy = "active-required" } = {}) {
  const resolution = resolveStatus({ statusRef, manifestId, revocationCursor, lastSeenCursor, transport });
  const disposition = applyRevocationPolicy(resolution, { policy });
  return { ...disposition, reason: resolution.reason, httpStatus: resolution.httpStatus, response: resolution.response };
}

/**
 * Factory returning a `(statusRef, cursor) => UmRevocationStatus` callback with
 * the EXACT signature the reference evaluator's `resolveRevocation` option
 * expects (Base §3.4). Plugging this into evaluateUniversalManifestV04 drives
 * the REAL reference receipt from this module's resolution logic — the interop
 * proof used by verify.mjs. Synchronous (the demo authority is in-memory).
 */
export function makeResolveRevocation({ transport, manifestId, lastSeenCursor } = {}) {
  return function resolveRevocation(statusRef, cursor) {
    const { revocationStatus } = resolveStatus({ statusRef, manifestId, revocationCursor: cursor, lastSeenCursor, transport });
    return revocationStatus;
  };
}

// ===========================================================================
// 5) Demo-local status authority (LABELED). An in-memory, synchronous mock of a
//    conformant status endpoint (§O2.5): it serves §O2.2-schema-valid responses
//    keyed by manifestId and exposes controls to flip a manifest active→revoked
//    (or suspended) mid-session — the demo's fixture-local status authority.
//    NOT a live external service (honesty ceiling).
// ===========================================================================

function manifestIdFromRef(ref) {
  if (typeof ref !== "string") return null;
  const i = ref.indexOf(DEMO_STATUS_ORIGIN);
  if (i === 0) return decodeURIComponent(ref.slice(DEMO_STATUS_ORIGIN.length));
  return ref; // allow a bare manifestId as the "ref" too
}

export function makeDemoStatusAuthority({ now } = {}) {
  const clock = () => (typeof now === "function" ? now() : now) || new Date().toISOString();
  const records = new Map(); // manifestId -> { status, cursor(number), updatedAt, reason?, nextCheck? }
  let offline = false;

  const bump = (rec) => {
    rec.cursor = (rec.cursor ?? 0) + 1;
    rec.updatedAt = clock();
    return rec;
  };

  const api = {
    /** The statusRef URI to embed in signature.statusRef for a given manifest. */
    statusRefFor(manifestId) {
      return `${DEMO_STATUS_ORIGIN}${encodeURIComponent(manifestId)}`;
    },
    register(manifestId, { status = "active", cursor = 1, nextCheck = "PT1H" } = {}) {
      records.set(manifestId, { status, cursor, updatedAt: clock(), nextCheck });
      return api;
    },
    revoke(manifestId, { reason = "holder-initiated revocation (demo)" } = {}) {
      const rec = records.get(manifestId) || { status: "active", cursor: 1 };
      rec.status = "revoked";
      rec.reason = reason;
      records.set(manifestId, bump(rec));
      return api;
    },
    suspend(manifestId, { reason = "temporary suspension (demo)" } = {}) {
      const rec = records.get(manifestId) || { status: "active", cursor: 1 };
      rec.status = "suspended";
      rec.reason = reason;
      records.set(manifestId, bump(rec));
      return api;
    },
    reinstate(manifestId) {
      const rec = records.get(manifestId) || { status: "revoked", cursor: 1 };
      rec.status = "active";
      delete rec.reason;
      records.set(manifestId, bump(rec));
      return api;
    },
    setOffline(v) {
      offline = !!v;
      return api;
    },
    /** The `cursor` currently served for a manifest (as a string), or undefined. */
    currentCursor(manifestId) {
      const rec = records.get(manifestId);
      return rec ? `v${rec.cursor}` : undefined;
    },
    /**
     * The transport function for resolveStatus/makeResolveRevocation. Models the
     * §O2.1 GET + §O2.4 error surface: unknown manifest ⇒ 404; offline ⇒ offline
     * sentinel; else a 200 with a §O2.2-schema-valid body.
     */
    transport(ref) {
      if (offline) return { httpStatus: 0, offline: true };
      const manifestId = manifestIdFromRef(ref);
      const rec = manifestId != null ? records.get(manifestId) : undefined;
      if (!rec) return { httpStatus: 404 };
      const body = buildStatusEndpointResponse({
        manifestId,
        status: rec.status,
        updatedAt: rec.updatedAt,
        reason: rec.reason,
        cursor: `v${rec.cursor}`,
        nextCheck: rec.nextCheck,
      });
      return { httpStatus: 200, body };
    },
  };
  return api;
}

// ===========================================================================
// 6) Demo journey surface — revoke the visitor's manifest mid-session ⇒ the next
//    evaluation rejects with revocationStatus "revoked" and the receipt shows it;
//    a non-resolving mode continues to report "unchecked" (the honest §2.18
//    permitted answer). Pure data (no rendering) so the UI + the driver share it.
// ===========================================================================

/**
 * @param {object} args
 * @param {string} args.manifestId
 * @param {string} args.statusRef
 * @param {string} [args.revocationCursor]
 * @param {ReturnType<typeof makeDemoStatusAuthority>} args.authority
 * @param {string} [args.policy] - default "active-required" (R9)
 */
export function buildStatusRefDemoSurface({ manifestId, statusRef, revocationCursor, authority, policy = "active-required" } = {}) {
  const resolveNow = () => evaluateStatusRef({ statusRef, manifestId, revocationCursor, transport: authority.transport, policy });

  // Beat 1 — baseline: authority serves "active" ⇒ accept.
  const baseline = resolveNow();

  // Beat 2 — the holder revokes mid-session ⇒ next evaluation DENIES (revoked).
  authority.revoke(manifestId);
  const afterRevoke = resolveNow();

  // Beat 3 — the honest non-resolving mode: no resolver wired ⇒ "unchecked".
  //   (§2.18: an evaluator not implementing revocation-aware verification MUST
  //    report "unchecked" and MUST NOT claim revocation-aware conformance.)
  const nonResolving = applyRevocationPolicy({ revocationStatus: "unchecked", reason: REASON_UNCHECKED }, { policy: "spec-default" });

  return {
    manifestId,
    statusRef,
    policy,
    baseline: { result: baseline.result, revocationStatus: baseline.revocationStatus, outcome: baseline.outcome },
    afterRevoke: {
      result: afterRevoke.result,
      revocationStatus: afterRevoke.revocationStatus,
      outcome: afterRevoke.outcome,
      warnings: afterRevoke.warnings.map((w) => w.code),
    },
    nonResolving: { result: nonResolving.result, revocationStatus: nonResolving.revocationStatus, outcome: nonResolving.outcome },
  };
}

// ===========================================================================
// 7) Honest capability descriptor — mirrors feature_CONFORMANCE. Flips nothing.
// ===========================================================================

export const feature_CONFORMANCE = Object.freeze({
  wo: "runtime",
  standard: "Universal Manifest v0.4 EXT-OPT §O2 (statusRef Resolution Schema) + EVAL-18 (§2.18) + RP1 bar R9",
  // NO expected.json fixture exists for statusRef — acceptance is spec-surface.
  fixture_owned: false,
  // REAL, deterministic surfaces:
  response_schema_conformant: true, // emits/consumes §O2.2 $defs.statusRefResponse; validator mirrors the reference
  status_semantics_real: true, // §O2.3 active/revoked/suspended dispositions
  error_handling_real: true, // §O2.4 404/503/network/offline/other ⇒ unchecked + the right reason
  cursor_monotonicity_real: true, // §5.2/§O2.1 revocationCursor floor; regression refused
  fail_closed_active_required: true, // R9: not-active (incl. unresolvable) ⇒ DENY
  reference_evaluator_interop: true, // makeResolveRevocation drives evaluateUniversalManifestV04's real receipt
  // Deliberately NOT claimed (honesty ceiling):
  live_external_status_service: false, // the authority is a demo-local / mock resolver, LABELED
  federated_resolvers: false, // EXT-OPT §O5 federation is out of scope (deferred in-spec)
  bitstring_status_list: false, // §O2.4 W3C Bitstring alt-target not implemented
  policy_state_profile_o26: false, // §O2.6 PREVIEW (supersededBy / policyWindow) not implemented
  um_conformance_flag_flipped: false,
  scoped_claim:
    "runtime implements REAL, deterministic statusRef revocation resolution: a §O2.2-schema-conformant " +
    "status-endpoint response (validator mirrors the reference assertStatusRefResponseV04 and is cross-checked " +
    "against schema.json $defs.statusRefResponse), §O2.3 dispositions (active⇒accept, suspended⇒accepted-with-" +
    "warnings, revoked⇒reject) exercised through the REAL reference evaluator via makeResolveRevocation, §O2.4 " +
    "error handling (unreachable/404/503/offline/malformed ⇒ unchecked + the classified reason), and §5.2/§O2.1 " +
    "cursor-floor monotonicity (regression refused). Under the RP1 R9 active-required policy — the demo default — " +
    "revoked, suspended, unreachable, offline, malformed, cursor-regression, id-mismatch, and non-HTTPS all DENY " +
    "fail-closed. The status authority is a demo-local / mock resolver (labeled, in-memory), NOT a live external " +
    "service. NO expected.json fixture exists (spec-surface acceptance). No conformance flag is flipped.",
});
