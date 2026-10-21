// v0.4 consent gating engine (Stage-4 Consent).
//
// This module is the Stage-4 (Consent) owner for the demo: facetRef-matched
// consent evaluation with a fail-closed status vocabulary, plus the portaling
// crossing sensor-gating surface (page bars P8 + RP1 R8/R9).
//
//   Stage-4 Consent      — match consents[].facetRef against each facet @id;
//                          record processed | consent-missing | consent-denied
//                          (CONFORMANCE.md §36 / spec §1.4.4 / §3.1.4).
//   4-value denial vocab — expired | withdrawn | scope-mismatch | condition-violated
//                          (CONFORMANCE.md fixture rows; spec §1.4.4).
//   Sensor gating (P8/R8)— eye-tracking denied, hand-tracking granted,
//                          room-geometry occluder-only, microphone post-server-mix;
//                          denials HOLD regardless of what any service asks and
//                          under enterprise reinforcement (fail-closed monotonicity).
//
// Spec sources (READ-ONLY, ):
//   spec/v0.4/CONFORMANCE.md   evaluator MUST list, esp:
//     · #6  per-facet status set: processed | opaque | consent-denied |
//           consent-missing | trustTierUnsupported | assuranceInsufficient |
//           not-projected | written (spec §3.3.1)
//     · #8  "Match consents[].facetRef against each projected facet's @id. When
//           no matching consent entry exists, record consent-missing and MUST NOT
//           process the facet's data. Treat expired or withdrawn consents as
//           absent." (spec §1.4.4, §3.1.4)
//     · §fixtures rows facet-without-consent / consent-expired / consent-withdrawn
//           / consent-scope-mismatch-read / consent-unknown-condition
//           / consent-missing-facet-ref (the six this change owns)
//     · §PREVIEW note: "unrecognized or unenforceable consent conditions fail closed"
//   spec/v0.4/schema.json      $defs.consent — REQUIRED @id, @type:um:Consent,
//                              facetRef, scope, purpose, grantedAt, expiresAt;
//                              OPTIONAL grantor, withdrawnAt, conditions.
//   conformance/v0.4/expected.json  the six fixture entries this change owns
//     (pinned evaluationContext.now = 2026-06-01T00:01:00.000Z; the read-path
//      scope fixture pins evaluationContext.intendedScope = ["read"]).
//
// ---------------------------------------------------------------------------
// HONESTY CEILING — what is REAL vs demonstration (machine-readable descriptor:
// feature_CONSENT_CONFORMANCE below; every real:true is exercised by
// web/manifest/verify.mjs against the external suite):
//   REAL   facetRef → facet @id matching                 (spec §1.4.4 MUST #8)
//   REAL   4-value fail-closed denial vocabulary          expired/withdrawn/
//                                                          scope-mismatch/condition-violated
//   REAL   expired & withdrawn consents treated as absent  (denied, not processed)
//   REAL   unknown/unenforceable condition ⇒ fail closed   (Base recognizes NO
//                                                            conditions ⇒ any
//                                                            condition ⇒ denied)
//   REAL   literal intendedScope ⊆ consent.scope check     (read-path fail-closed)
//   REAL   consent-missing-facet-ref schema reject          (facetRef REQUIRED)
//   DEMO   crossing sensor gates (P8/R8/R9)                 fixed crossing-scenario
//          dispositions with fail-closed MONOTONICITY: a service request or
//          enterprise reinforcement can only TIGHTEN, never loosen; a deny always
//          holds. There are NO sensor-gating fixtures in expected.json — this is a
//          page-visible DEMONSTRATION of the fail-closed principle the fixture
//          engine proves, not a v0.4 conformance claim.
// This module flips NO um_conformance flag. Scope: the six consent fixtures
// + the crossing sensor surface. NOT the full six-stage evaluator (composes
// that); NOT signature/TTL verification; NOT
// write-consent / unlock-window / key-lifecycle;
// NOT SOM/inter-service sensor denials.
// ---------------------------------------------------------------------------
//
// FILE DISCIPLINE: this is a NEW, specific module. It imports only the
// signing library (read-only reuse for the Verify precondition) and is
// imported by nothing yet. Registration into the shared v0.4 conformance runner
// is via registerWo122() (see the hook at the bottom) — one wiring block, applied
// by the integration step, not by this module. The shared v0.1-baseline runner
// (web/conformance/run-um-conformance.mjs) is untouched.

import { verifyManifestProfileA } from "../signing/um-signature-profile-a.mjs";

// ===========================================================================
// Constants (schema.json $defs.consent + CONFORMANCE §36 status set)
// ===========================================================================

/** REQUIRED consent members (schema.json $defs.consent.required). */
export const CONSENT_REQUIRED_FIELDS = Object.freeze([
  "@id",
  "@type",
  "facetRef",
  "scope",
  "purpose",
  "grantedAt",
  "expiresAt",
]);

/**
 * The subset of the v0.4 per-facet status set (CONFORMANCE §6 / spec §3.3.1)
 * that the Consent stage produces. `processed` = a valid governing consent;
 * `consent-missing` = no consent governs the facet (facet NOT processed);
 * `consent-denied` = a governing consent exists but failed a fail-closed check.
 * (opaque / trustTierUnsupported / assuranceInsufficient / not-projected /
 * written are produced by other stages/tasks — 132/133/135/123/140.)
 */
export const FACET_CONSENT_STATUSES = Object.freeze(["processed", "consent-missing", "consent-denied"]);

/**
 * THE 4-VALUE CONSENT STATUS VOCABULARY — the denial reasons a governing consent
 * can carry (each ⇒ facet `consent-denied`). This is the vocabulary the task title
 * names and expected.json asserts in expectedConsentStatus.status.
 */
export const CONSENT_DENIAL_STATUSES = Object.freeze([
  "expired", // now outside [grantedAt, expiresAt) — treated as absent (spec §1.4.4)
  "withdrawn", // withdrawnAt set and reached — treated as absent (spec §1.4.4)
  "scope-mismatch", // an intended operation is not literally present in consent.scope
  "condition-violated", // a condition the evaluator cannot recognize/enforce ⇒ fail closed
]);

/** The pass state of a governing consent (facet ⇒ processed). Not a denial. */
export const CONSENT_STATUS_GRANTED = "granted";

/** Full consent-status value set = the pass state + the 4-value denial vocab. */
export const CONSENT_STATUSES = Object.freeze([CONSENT_STATUS_GRANTED, ...CONSENT_DENIAL_STATUSES]);

/**
 * Conditions the Base evaluator can recognize AND enforce. v0.4 Base defines NO
 * standard, machine-enforceable consent-condition vocabulary (conditions are
 * opaque URIs such as `um:condition:example-geofence`). Therefore the default
 * recognized set is EMPTY and any condition fails closed (CONFORMANCE PREVIEW
 * note: "unrecognized or unenforceable consent conditions fail closed"). A
 * consumer that has externally satisfied a condition may pass its id via
 * context.satisfiedConditions — an explicit, auditable escape hatch, never a
 * default. Fail closed is the default.
 */
export const RECOGNIZED_ENFORCEABLE_CONDITIONS = Object.freeze([]);

/** Receipt outcome vocabulary used by the Consent-stage composition. */
export const CONSENT_RECEIPT_OUTCOMES = Object.freeze(["accepted", "accepted-partial", "rejected"]);

// Machine-readable scoped-claim descriptor (pattern: feature_CONFORMANCE /
// SIGNING_CONFORMANCE). Every `true` is backed by verify.mjs output.
export const feature_CONSENT_CONFORMANCE = Object.freeze({
  wo: "runtime",
  standard: "Universal Manifest v0.4 Base — Stage-4 Consent (spec §1.4.4 / §3.1.4; CONFORMANCE evaluator MUST #6/#8)",
  fixtures_owned: 6, // 5 evaluation (valid/) + 1 schema reject (invalid/consent-missing-facet-ref)
  // REAL consent surfaces:
  facet_ref_matching_real: true, // consents[].facetRef ↔ facet @id
  four_value_denial_vocab_real: true, // expired | withdrawn | scope-mismatch | condition-violated
  expired_withdrawn_treated_as_absent: true, // ⇒ consent-denied, facet NOT processed
  unknown_condition_fails_closed: true, // Base recognizes no conditions ⇒ any condition ⇒ denied
  literal_scope_check_real: true, // intendedScope ⊆ consent.scope, literal string membership
  consent_missing_facet_ref_reject_real: true, // facetRef REQUIRED (schema-detectable)
  deny_holds_regardless_of_service_request: true, // a request can never raise a gate above its base
  // DEMONSTRATION surface (NO fixtures — page-visible crossing scenario):
  crossing_sensor_gating_demo: true, // P8/R8/R9 fixed-disposition surface, fail-closed monotonic
  // Explicit NON-claims (owned elsewhere / not implemented here):
  full_six_stage_evaluator: false, // composes; this is the Stage-4 slice
  write_consent_unlock_window: false, // PREVIEW extends this base engine
  signature_ttl_verification: false, // reused read-only for the Verify precondition
  um_conformance_flag_flipped: false,
  scoped_claim:
    "runtime implements REAL v0.4 Stage-4 consent gating: facetRef→facet matching, the 4-value " +
    "fail-closed denial vocabulary (expired/withdrawn/scope-mismatch/condition-violated), " +
    "expired+withdrawn-as-absent, unknown-condition-fails-closed, literal intendedScope⊆scope, and " +
    "the consent-missing-facet-ref schema reject — the six fixtures it owns, matched under each " +
    "entry's PINNED evaluationContext. The crossing sensor gates (P8/R8) are a page-visible " +
    "DEMONSTRATION of fail-closed monotonicity (no expected.json fixtures). Signature/TTL is REUSED " +
    "from runtime/119 (not re-implemented). This is the Stage-4 slice, not the full evaluator.",
});

// ===========================================================================
// Small helpers (browser-safe; no Buffer)
// ===========================================================================

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isIsoDateTime(v) {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function isNonEmptyStringArray(v) {
  return isStringArray(v) && v.length > 0;
}
/** @type includes um:Consent (string or array form, per §2.1 shape convention). */
function hasConsentType(t) {
  return t === "um:Consent" || (Array.isArray(t) && t.includes("um:Consent"));
}

// ===========================================================================
// 1) STRUCTURAL SURFACE — envelope + consent shape (schema.json $defs.consent)
// ===========================================================================

/** Minimal v0.4 envelope shape check (mirrors the reference evaluator's Arrive gate). */
function envelopeErrors(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["manifest must be an object"];
  const ctx = manifest["@context"];
  const hasV04 =
    ctx === "https://universalmanifest.net/ns/v0.4" ||
    (Array.isArray(ctx) && ctx.includes("https://universalmanifest.net/ns/v0.4"));
  if (!hasV04) errors.push("@context must include https://universalmanifest.net/ns/v0.4 (Section 1.2.1)");
  if (!isNonEmptyString(manifest["@id"])) errors.push("Missing @id");
  const t = manifest["@type"];
  if (!(t === "um:Manifest" || (Array.isArray(t) && t.includes("um:Manifest")))) errors.push("Missing um:Manifest in @type");
  if (manifest.manifestVersion !== "0.4") errors.push("manifestVersion must be 0.4");
  if (!isNonEmptyString(manifest.subject)) errors.push("Missing subject");
  if (!isIsoDateTime(manifest.issuedAt)) errors.push("issuedAt must be an ISO 8601 date-time");
  if (!isIsoDateTime(manifest.expiresAt)) errors.push("expiresAt must be an ISO 8601 date-time");
  return errors;
}

/**
 * Validate ONE consent entry's shape against schema.json $defs.consent.
 * The consent-missing-facet-ref fixture is a SCHEMA reject precisely because
 * facetRef is REQUIRED. Returns string[] of errors (empty ⇒ shape-valid).
 */
export function consentEntryShapeErrors(consent, index = 0) {
  const at = `consents[${index}]`;
  if (!consent || typeof consent !== "object" || Array.isArray(consent)) return [`${at}: must be an object`];
  const errors = [];
  if (!isNonEmptyString(consent["@id"])) errors.push(`${at}: missing required @id`);
  if (!hasConsentType(consent["@type"])) errors.push(`${at}: @type must include um:Consent`);
  if (!isNonEmptyString(consent.facetRef)) errors.push(`${at}: missing required facetRef (Section 1.4.4)`);
  if (!isNonEmptyStringArray(consent.scope)) errors.push(`${at}: scope must be a non-empty string array`);
  if (!isNonEmptyString(consent.purpose)) errors.push(`${at}: missing required purpose`);
  if (!isIsoDateTime(consent.grantedAt)) errors.push(`${at}: grantedAt must be an ISO 8601 date-time`);
  if (!isIsoDateTime(consent.expiresAt)) errors.push(`${at}: expiresAt must be an ISO 8601 date-time`);
  // Optional fields: validate shape only if present.
  if (consent.withdrawnAt !== undefined && !isIsoDateTime(consent.withdrawnAt)) {
    errors.push(`${at}: withdrawnAt, when present, must be an ISO 8601 date-time`);
  }
  if (consent.conditions !== undefined && !isStringArray(consent.conditions)) {
    errors.push(`${at}: conditions, when present, must be a string array`);
  }
  return errors;
}

/**
 * Structural validation of a manifest's consent block (all entries).
 * Returns { valid, errors }.
 */
export function validateConsentStructural(manifest) {
  const errors = [];
  const consents = Array.isArray(manifest?.consents) ? manifest.consents : [];
  consents.forEach((c, i) => errors.push(...consentEntryShapeErrors(c, i)));
  return { valid: errors.length === 0, errors };
}

/**
 * STRUCTURAL verdict for a fixture (clock-independent). Envelope + consent
 * shapes first; signature LAST (a shape defect reports its own reason, not a
 * crypto one — mirrors the pattern). This is the path that rejects
 * invalid/consent-missing-facet-ref (facetRef REQUIRED) as schema-detectable.
 * Returns { result: "accept"|"reject", reasons, checks }.
 */
export async function structuralVerdictConsent(manifest) {
  const reasons = [];
  reasons.push(...envelopeErrors(manifest));
  reasons.push(...validateConsentStructural(manifest).errors);
  let sigReason = "not-evaluated";
  if (reasons.length === 0) {
    const sigReport = await verifyManifestProfileA(manifest);
    sigReason = sigReport.reason;
    if (!sigReport.ok) reasons.push(`signature verification failed: ${sigReport.reason}`);
  }
  return {
    result: reasons.length === 0 ? "accept" : "reject",
    reasons,
    checks: { signature: sigReason },
  };
}

// ===========================================================================
// 2) CORE CONSENT ENGINE — facetRef matching + 4-value fail-closed vocabulary
//    (the reusable API consumed private-data and SOM gating).
// ===========================================================================

/**
 * Find the consent entry governing a facet: consents[].facetRef === facet @id.
 * Returns { consent, index } for the FIRST match, or { consent: null, index: -1 }
 * when no consent governs the facet. (The suite pairs one consent per facet;
 * multi-consent arbitration is not exercised and would need a policy decision.)
 */
export function matchConsentForFacet(facetId, consents) {
  const list = Array.isArray(consents) ? consents : [];
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (c && typeof c === "object" && c.facetRef === facetId) return { consent: c, index: i };
  }
  return { consent: null, index: -1 };
}

/**
 * Evaluate ONE governing consent under a pinned context. FAIL-CLOSED PRECEDENCE
 * (most-authoritative first):
 *   1. withdrawn      — withdrawnAt set and reached ⇒ treated as absent
 *   2. expired        — now outside [grantedAt, expiresAt) ⇒ treated as absent
 *   3. condition      — any condition not recognized/enforceable ⇒ fail closed
 *   4. scope-mismatch — an intended op not literally present in consent.scope
 *   else              — granted (facet may be processed)
 * `context.now` is the PINNED evaluation instant (never the wall clock).
 * `context.intendedScope` (optional array) is the operation(s) the evaluating
 * party intends; when absent the scope check is not applicable (no declared op).
 * `context.satisfiedConditions` (optional array) lists condition ids an external
 * enforcer has satisfied; default empty ⇒ any condition fails closed.
 * Returns { consentRef, facetRef, status, reason, granted }.
 */
export function evaluateConsentEntry(consent, context = {}) {
  const consentRef = consent && isNonEmptyString(consent["@id"]) ? consent["@id"] : "(unknown-consent)";
  const facetRef = consent && isNonEmptyString(consent.facetRef) ? consent.facetRef : null;
  const nowMs = isIsoDateTime(context.now) ? Date.parse(context.now) : Date.now();
  const deny = (status, reason) => ({ consentRef, facetRef, status, reason, granted: false });

  // 1) Withdrawal — an explicit revocation is the strongest signal; treated as absent.
  if (isIsoDateTime(consent.withdrawnAt) && Date.parse(consent.withdrawnAt) <= nowMs) {
    return deny("withdrawn", `consent withdrawn at ${consent.withdrawnAt} (treated as absent; spec §1.4.4)`);
  }

  // 2) Validity window — valid iff grantedAt <= now < expiresAt; otherwise treated
  //    as absent. The tested path is expiry (now >= expiresAt); a not-yet-valid
  //    consent (now < grantedAt) is EQUALLY denied (fail closed) and mapped to the
  //    same lifecycle-window disposition to keep the vocabulary at four values.
  const grantedMs = Date.parse(consent.grantedAt);
  const expiresMs = Date.parse(consent.expiresAt);
  if (!Number.isFinite(expiresMs) || nowMs >= expiresMs) {
    return deny("expired", `consent expired at ${consent.expiresAt} (treated as absent; spec §1.4.4)`);
  }
  if (Number.isFinite(grantedMs) && nowMs < grantedMs) {
    return deny("expired", `consent not yet valid (grantedAt ${consent.grantedAt} is in the future; treated as absent)`);
  }

  // 3) Conditions — fail closed on anything the evaluator cannot recognize/enforce.
  const conditions = Array.isArray(consent.conditions) ? consent.conditions : [];
  if (conditions.length > 0) {
    const satisfied = new Set(Array.isArray(context.satisfiedConditions) ? context.satisfiedConditions : []);
    const recognized = new Set(RECOGNIZED_ENFORCEABLE_CONDITIONS);
    const unmet = conditions.filter((cond) => !(recognized.has(cond) && satisfied.has(cond)));
    if (unmet.length > 0) {
      return deny(
        "condition-violated",
        `consent carries condition(s) the evaluator cannot recognize or enforce: ${unmet.join(", ")} (fail closed)`
      );
    }
  }

  // 4) Scope — the intended operation(s) must be LITERALLY present in consent.scope.
  const scope = Array.isArray(consent.scope) ? consent.scope : [];
  if (isNonEmptyStringArray(context.intendedScope)) {
    const missing = context.intendedScope.filter((op) => !scope.includes(op));
    if (missing.length > 0) {
      return deny(
        "scope-mismatch",
        `intended operation(s) [${missing.join(", ")}] not literally present in consent.scope [${scope.join(", ")}]`
      );
    }
  }

  return { consentRef, facetRef, status: CONSENT_STATUS_GRANTED, reason: "consent valid for the requested context", granted: true };
}

/**
 * PURE Stage-4 Consent engine over a manifest's facets. For each facet:
 *   · no governing consent      ⇒ facet status `consent-missing`, NOT processed
 *   · governing consent granted ⇒ facet status `processed`
 *   · governing consent denied  ⇒ facet status `consent-denied` + a consentStatus
 * Returns {
 *   facetStatuses:  [{ facetId, status, consentRef? }],
 *   consentStatuses:[{ consentRef, facetRef, status, reason }],  // every evaluated consent
 *   processed: string[], notProcessed: string[],
 * }
 * No signature/TTL here — this is the pure consent stage (Verify is a precondition
 * handled by evaluateConsentGating / the caller). Consumed.
 */
export function evaluateConsentStage(manifest, context = {}) {
  const facets = Array.isArray(manifest?.facets) ? manifest.facets : [];
  const consents = Array.isArray(manifest?.consents) ? manifest.consents : [];
  const facetStatuses = [];
  const consentStatuses = [];
  const processed = [];
  const notProcessed = [];

  for (const facet of facets) {
    const facetId = facet && isNonEmptyString(facet["@id"]) ? facet["@id"] : "(unknown-facet)";
    const { consent } = matchConsentForFacet(facetId, consents);

    if (!consent) {
      // MUST NOT process a facet with no governing consent (spec §1.4.4 MUST #8).
      facetStatuses.push({ facetId, status: "consent-missing" });
      notProcessed.push(facetId);
      continue;
    }

    const evalResult = evaluateConsentEntry(consent, context);
    consentStatuses.push({
      consentRef: evalResult.consentRef,
      facetRef: evalResult.facetRef,
      status: evalResult.status,
      reason: evalResult.reason,
    });

    if (evalResult.granted) {
      facetStatuses.push({ facetId, status: "processed", consentRef: evalResult.consentRef });
      processed.push(facetId);
    } else {
      // Expired/withdrawn/scope-mismatch/condition-violated ⇒ facet not processed.
      facetStatuses.push({ facetId, status: "consent-denied", consentRef: evalResult.consentRef });
      notProcessed.push(facetId);
    }
  }

  return { facetStatuses, consentStatuses, processed, notProcessed };
}

// ===========================================================================
// 3) FULL EVALUATE SLICE — Verify precondition (reused) + Consent stage +
//    receipt composition. This is the fixture-facing evaluate.
// ===========================================================================

/**
 * Evaluate a manifest through the Verify precondition then the Consent stage,
 * at the PINNED context.now, composing a receipt whose fields expected.json
 * asserts (outcome, facetStatuses, consentStatuses).
 *   Arrive/Verify: envelope shape + consent shape + signature +
 *                  freshness (60s skew / expiry at pinned now). Fail ⇒ rejected.
 *   Consent:       evaluateConsentStage.
 *   Compose:       any facet not processed (consent-missing/consent-denied) while
 *                  the envelope is accepted ⇒ `accepted-partial`; all processed
 *                  (or no facets) ⇒ `accepted`.
 * Returns { result: "accept"|"reject", receipt }.
 */
export async function evaluateConsentGating(manifest, context = {}) {
  const nowMs = isIsoDateTime(context.now) ? Date.parse(context.now) : Date.now();
  const manifestId = manifest && typeof manifest === "object" && isNonEmptyString(manifest["@id"]) ? manifest["@id"] : "(unknown)";
  const warnings = [];
  const receipt = {
    "@type": "um:Receipt",
    manifestId,
    outcome: "rejected",
    signatureCheck: "not-evaluated",
    freshnessCheck: "not-evaluated",
    facetStatuses: [],
    consentStatuses: [],
    warnings,
  };
  const finish = (outcome) => {
    receipt.outcome = outcome;
    return { result: outcome === "rejected" ? "reject" : "accept", receipt };
  };

  // --- Arrive/Verify: structure (envelope + consent shape) ------------------
  const structural = [...envelopeErrors(manifest), ...validateConsentStructural(manifest).errors];
  if (structural.length > 0) {
    warnings.push({ code: "um:reason:structure:malformed", message: `Verify stage: ${structural.join("; ")}` });
    return finish("rejected");
  }

  // --- Arrive/Verify: signature --
  const sig = manifest.signature;
  if (!sig || typeof sig !== "object") {
    warnings.push({ code: "um:reason:crypto:signature-missing", message: "Verify stage: missing signature" });
    return finish("rejected");
  }
  const sigReport = await verifyManifestProfileA(manifest);
  if (!sigReport.ok) {
    receipt.signatureCheck = sigReport.reason === "unsupported-profile" ? "unsupported-profile" : "invalid";
    warnings.push({ code: "um:reason:crypto:signature-invalid", message: `Verify stage: ${sigReport.reason}` });
    return finish("rejected");
  }
  receipt.signatureCheck = "valid";

  // --- Arrive/Verify: freshness at the PINNED now (§3.1.2; 60s skew) ---------
  const SKEW_MS = 60_000;
  const issuedMs = Date.parse(manifest.issuedAt);
  const expiresMs = Date.parse(manifest.expiresAt);
  if (Number.isFinite(issuedMs) && issuedMs - nowMs > SKEW_MS) {
    receipt.freshnessCheck = "stale";
    warnings.push({ code: "um:reason:freshness:stale", message: "Verify stage: issuedAt more than 60s in the future" });
    return finish("rejected");
  }
  if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
    receipt.freshnessCheck = "expired";
    warnings.push({ code: "um:reason:freshness:expired", message: "Verify stage: manifest expired" });
    return finish("rejected");
  }
  receipt.freshnessCheck = "fresh";

  // --- Stage-4 Consent -------------------------------------------------------
  const stage = evaluateConsentStage(manifest, context);
  receipt.facetStatuses = stage.facetStatuses;
  receipt.consentStatuses = stage.consentStatuses;
  for (const cs of stage.consentStatuses) {
    if (cs.status !== CONSENT_STATUS_GRANTED) {
      warnings.push({ code: `um:reason:consent:${cs.status}`, message: `Consent stage: ${cs.consentRef} ⇒ ${cs.status} (${cs.reason})` });
    }
  }
  for (const fs of stage.facetStatuses) {
    if (fs.status === "consent-missing") {
      warnings.push({ code: "um:reason:consent:consent-missing", message: `Consent stage: facet ${fs.facetId} has no governing consent ⇒ consent-missing, not processed` });
    }
  }

  // --- Compose the outcome ---------------------------------------------------
  // Envelope accepted; a facet present-but-not-processed ⇒ partial acceptance.
  if (stage.notProcessed.length > 0) return finish("accepted-partial");
  return finish("accepted");
}

// ===========================================================================
// 4) CROSSING SENSOR GATING — page bars P8 (portaling) + R8/R9 (RP1).
//    A page-visible DEMONSTRATION of fail-closed monotonicity: a service request
//    or enterprise reinforcement can only TIGHTEN a gate, never loosen it; a deny
//    always holds. NO expected.json fixtures back this (it is scenario, not
//    conformance) — the honesty ceiling is explicit in feature_CONSENT_CONFORMANCE.
// (SOM / inter-service sensor denials) consumes gateSensorRequest.
// ===========================================================================

/** Sensor dispositions, most-protective → least. `granted` is the only unconstrained grant. */
export const SENSOR_DISPOSITIONS = Object.freeze(["denied", "occluder-only", "post-server-mix", "granted"]);

/**
 * Restrictiveness rank: LOWER = more restrictive / more protective. A gate's
 * effective disposition may only move to an EQUAL-or-LOWER rank than its base
 * (fail-closed monotonicity). occluder-only and post-server-mix are DISTINCT
 * constrained modes at the same protective level — one never substitutes for the
 * other, and neither rises to `granted`.
 */
const DISPOSITION_RANK = Object.freeze({ denied: 0, "occluder-only": 1, "post-server-mix": 1, granted: 2 });
function dispositionRank(d) {
  return Object.prototype.hasOwnProperty.call(DISPOSITION_RANK, d) ? DISPOSITION_RANK[d] : 0; // unknown ⇒ deny-rank
}

/**
 * The crossing's base sensor gates — the consent decisions carried across the
 * portal boundary (page narrative P8; RP1 sensor list R8). Frozen.
 */
export const CROSSING_SENSOR_GATES = Object.freeze({
  "eye-tracking": Object.freeze({
    disposition: "denied",
    rationale: "biometric-grade gaze data; no consent facet grants it — denied at the boundary",
  }),
  "hand-tracking": Object.freeze({
    disposition: "granted",
    rationale: "interaction-necessary; consented for the crossing",
  }),
  "room-geometry": Object.freeze({
    disposition: "occluder-only",
    rationale: "shared only as occlusion geometry; raw mesh/layout never exposed",
  }),
  microphone: Object.freeze({
    disposition: "post-server-mix",
    rationale: "only the server-mixed audio stream is exposed; raw mic never leaves the client",
  }),
});

/**
 * Resolve the EFFECTIVE disposition of one sensor under an optional service
 * request and/or enterprise reinforcement. Fail-closed invariants:
 *   · an unknown sensor ⇒ `denied` (default deny)
 *   · a service request can only move the gate to an EQUAL-or-MORE-restrictive
 *     disposition — it can NEVER raise it above the consented base ("deny holds
 *     regardless of what any service asks")
 *   · enterprise reinforcement (R8) can only TIGHTEN; it never un-denies a denied
 *     sensor and never lifts a constrained gate to `granted`
 * Returns { sensor, base, requested, enterpriseReinforced, effective, held, reason }.
 * `held` is the proof invariant: rank(effective) <= rank(base), always true.
 */
export function gateSensorRequest(sensor, { requestedDisposition = null, enterpriseReinforced = false } = {}) {
  const gate = Object.prototype.hasOwnProperty.call(CROSSING_SENSOR_GATES, sensor) ? CROSSING_SENSOR_GATES[sensor] : null;
  if (!gate) {
    return {
      sensor,
      base: null,
      requested: requestedDisposition,
      enterpriseReinforced,
      effective: "denied",
      held: true,
      reason: `unknown sensor '${sensor}' ⇒ default-deny (fail closed)`,
    };
  }
  const base = gate.disposition;
  let effective = base;
  let reason = `base disposition '${base}' (${gate.rationale})`;

  // A service request may only restrict further; a request to raise/keep is ignored.
  if (requestedDisposition != null) {
    if (dispositionRank(requestedDisposition) < dispositionRank(effective)) {
      effective = requestedDisposition;
      reason = `service voluntarily restricted to '${effective}' (more restrictive than base '${base}')`;
    } else if (requestedDisposition !== effective) {
      reason = `service requested '${requestedDisposition}' — NOT honored; base '${base}' holds (a request can never loosen a gate)`;
    }
  }

  // Enterprise reinforcement re-asserts the gates and may only tighten. For the
  // crossing R8 scenario it guarantees denials/constraints HOLD — it never lifts
  // rank. (An enterprise policy that adds NEW denials would gate other sensors;
  // it can never raise THIS gate above its base.)
  if (enterpriseReinforced && dispositionRank(effective) > dispositionRank(base)) {
    effective = base; // unreachable given the request rule above, but belt-and-suspenders fail-closed
    reason = `enterprise reinforcement clamped back to base '${base}' (denials hold under reinforcement)`;
  }

  return {
    sensor,
    base,
    requested: requestedDisposition,
    enterpriseReinforced,
    effective,
    held: dispositionRank(effective) <= dispositionRank(base),
    reason,
  };
}

/**
 * Build the full crossing sensor-gate surface for the demo (P8 visible in the
 * crossing; R8/R9 denials hold under enterprise reinforcement). `serviceRequests`
 * optionally maps sensor ⇒ requestedDisposition (a service asking for more than it
 * is granted). Returns { enterpriseReinforced, gates: [{...gateSensorRequest}],
 * allDenialsHeld }.
 */
export function buildCrossingSensorGateSurface({ enterpriseReinforced = false, serviceRequests = {} } = {}) {
  const gates = Object.keys(CROSSING_SENSOR_GATES).map((sensor) =>
    gateSensorRequest(sensor, {
      requestedDisposition: Object.prototype.hasOwnProperty.call(serviceRequests, sensor) ? serviceRequests[sensor] : null,
      enterpriseReinforced,
    })
  );
  return {
    enterpriseReinforced,
    gates,
    // Every gate's effective disposition is at or below its base rank — no request
    // and no reinforcement ever loosened a gate. This is the R9 fail-closed proof.
    allDenialsHeld: gates.every((g) => g.held),
  };
}

// ===========================================================================
// 5) CONFORMANCE-RUNNER REGISTRATION HOOK (the shared v0.4 runner wires this with
//    ONE block — applied by the integration step, not by this module).
// ===========================================================================

/** The six fixture files owns (5 evaluation valid/ + 1 schema reject invalid). */
export const feature_FIXTURE_FILENAMES = Object.freeze([
  "valid/facet-without-consent.jsonld",
  "valid/consent-expired.jsonld",
  "valid/consent-withdrawn.jsonld",
  "valid/consent-scope-mismatch-read.jsonld",
  "valid/consent-unknown-condition.jsonld",
  "invalid/consent-missing-facet-ref.jsonld",
]);

/**
 * Evaluate ONE fixture against its expected.json entry contract:
 *   entry.validationMode "evaluation" ⇒ evaluateConsentGating under entry.evaluationContext
 *   otherwise (schema reject)         ⇒ structuralVerdictConsent (clock-independent)
 * Returns { result: "accept"|"reject", reason, receipt? } — the adapter shape the
 * runner pattern uses, so the shared v0.4 runner can dispatch
 * fixtures to this handler with no impedance mismatch.
 */
export async function featureFixtureHandler(fixtureJson, expectedEntry = {}) {
  if (expectedEntry.validationMode === "evaluation") {
    const { result, receipt } = await evaluateConsentGating(fixtureJson, expectedEntry.evaluationContext || {});
    return { result, reason: receipt.warnings?.[0]?.message || receipt.outcome, receipt };
  }
  const verdict = await structuralVerdictConsent(fixtureJson);
  return { result: verdict.result, reason: verdict.reasons.join("; ") || "structural contract satisfied" };
}

/**
 * Registration hook for the shared v0.4 conformance runner. Contract:
 *   registry.register(filename, asyncHandler(fixtureJson, expectedEntry))
 * The integrator wires it with exactly (mirroring the block):
 *   import { registerWo122 } from "../manifest/consent-gating.mjs";
 *   const featureHandlers = new Map();
 *   const featureCount = registerWo122({ register: (f, h) => featureHandlers.set(f, h) });
 */
export function registerWo122(registry) {
  if (!registry || typeof registry.register !== "function") {
    throw new Error("registerWo122: registry with a register(filename, handler) function required");
  }
  for (const filename of feature_FIXTURE_FILENAMES) {
    registry.register(filename, featureFixtureHandler);
  }
  return feature_FIXTURE_FILENAMES.length;
}
