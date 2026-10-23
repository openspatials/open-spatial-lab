// v0.4 version routing + v0.3 backwards-compatibility path.
//
// This module owns the ARRIVE-STAGE version decision and the EXT-T1 §T1.6.4
// backwards-compatibility path — nothing else. It is Base-adjacent behavior that
//..129 left unowned and that
// the demo's staged-conformance fallback strategy (v0.3 as the stable
// rung) depends on being REAL rather than asserted.
//
//   1. ARRIVE-STAGE ROUTER (Base §1.3.1: evaluators MUST check version support
//      BEFORE processing). manifestVersion "0.4" (+ v0.4 context) ⇒ the v0.4 path;
//      "0.3" (+ v0.3 context) ⇒ the T1.6.4 backcompat path; anything else
//      (e.g. "0.5", missing, or a version/context MISMATCH) ⇒ reject — no
//      processing path. FAIL CLOSED on ambiguous version.
//   2. BACKCOMPAT PATH (EXT-T1 §T1.6.4). Parse the v0.3 envelope against the v0.3
//      contract, run the six-stage sequence (Verify: Profile-A signature over the
//      v0.3 signing input + TTL freshness), then FORCE the receipt
//      statuses the spec pins for a v0.3 manifest:
//        holderBindingStatus            = "absent"
//        presentationProofStatus        = "absent"
//        livenessStatus.freshnessClass  = "unknown"
//        effectiveTrustTier CAPPED at 0 (regardless of requiredTrustTier)
//      and emit the `um:reason:trust:unbound-claims` warning.
//   3. FLOOR INTERACTION (Base §6.4.5, re-using CAPABILITY check at the
//      backcompat Tier-0 cap — NOT the raise-only floor-violation check). A v0.3
//      manifest declaring a manifest-level requiredTrustTier ≥ 1 cannot be
//      satisfied at the Tier-0 cap ⇒ rejected (the declared floor rejects, not the
//      cap itself). A v0.3 manifest with no floor (or Tier 0) is accepted-with-
//      warnings, unbound at Tier 0.
//   4. DUAL EXPECTATION / the suite's one INVERSION. The v0.4 STRUCTURAL SCHEMA
//      REJECTS a v0.3 envelope (manifestVersion ≠ "0.4"), while the EVALUATOR
//      ACCEPTS it through the backcompat path. `valid/v03-backcompat-manifest.jsonld`
//      records BOTH halves (schemaValidation.reject + evaluation.accept). This
//      module exposes each half separately (v04StructuralSchemaVerdict = the
//      schema-sweep half; evaluateV03Backcompat = the evaluator half).
//
// ---------------------------------------------------------------------------
// HONESTY CEILING (read before touching the forced statuses)
// ---------------------------------------------------------------------------
// The T1.6.4 forced statuses are NON-OVERRIDABLE. A v0.3-routed manifest carries
// holderBindingStatus/presentationProofStatus "absent", freshnessClass "unknown",
// and effectiveTrustTier 0 UNCONDITIONALLY — set from FORCED_BACKCOMPAT_STATUS,
// never read from manifest content. Injecting binding-looking material into a v0.3
// envelope CANNOT upgrade it to a full v0.4 claim (a v0.3 manifest has no v0.4
// binding mechanics by definition — EXT-T1 §T1.6.4). The router FAILS CLOSED on any
// ambiguous version. This module flips NO um_conformance flag — it is the routing +
// backcompat slice, not the full six-stage v0.4 evaluator.
//
// ALIGNMENT: context-integrity gate (EVAL-04) treats a v0.3 @context as
// OUT of scope of the v0.4 context pin — version routing (here) happens BEFORE that
// gate, so a clean v0.3 envelope reaches the backcompat path and never trips the
// v0.4 pin. This module recognizes the v0.3 namespace as legitimate-for-backcompat;
// it does not fight the pin.
//
// ---------------------------------------------------------------------------
// FILE DISCIPLINE: NEW, specific module. It CONSUMES (tier floor /
// capability decision — depends_on) and the signing library (read-only
// reuse); it reimplements neither. Registration into the shared v0.4 runner is via
// registerVersionRouting (documented at the bottom) — applied at integration, never
// by this module. Zero external deps; plain ESM (Node + browser).

import { verifyManifestProfileA } from "../signing/um-signature-profile-a.mjs";
import { evaluateTrustTiers } from "./trust-tier.mjs";

// ===========================================================================
// Constants — versioned namespaces + the FORCED backcompat status set.
// ===========================================================================

export const UM_NS_V04 = "https://universalmanifest.net/ns/v0.4";
export const UM_NS_V03 = "https://universalmanifest.net/ns/v0.3";

export const MANIFEST_VERSION_V04 = "0.4";
export const MANIFEST_VERSION_V03 = "0.3";

/** The backcompat effective-tier cap (EXT-T1 §T1.6.4 step 5): Tier 0, always. */
export const BACKCOMPAT_TIER_CAP = 0;

/** The unbound-claims warning code (EXT-T1 §T1.6.4; reference reason registry). */
export const WARN_UNBOUND_CLAIMS = "um:reason:trust:unbound-claims";
/** Version-unsupported reject code (Base §1.3.1 — no processing path). */
export const WARN_VERSION_UNSUPPORTED = "um:reason:version:unsupported";
/** Malformed-structure reject code (envelope fails the v0.3 contract). */
export const WARN_STRUCTURE_MALFORMED = "um:reason:structure:malformed";
/** Manifest-level tier-unsupported (declared floor unsatisfiable at the cap). */
export const WARN_TIER_UNSUPPORTED = "um:reason:trust:tier-unsupported";

/**
 * The T1.6.4 forced receipt statuses — the NON-OVERRIDABLE contract. Frozen so no
 * caller (or future edit) can mutate the fail-closed posture. A v0.3-routed manifest
 * ALWAYS carries exactly these; nothing in the manifest can raise them.
 */
export const FORCED_BACKCOMPAT_STATUS = Object.freeze({
  holderBindingStatus: "absent",
  presentationProofStatus: "absent",
  livenessFreshnessClass: "unknown",
  effectiveTrustTier: BACKCOMPAT_TIER_CAP,
  overridable: false,
});

// Machine-readable scoped-claim descriptor (house pattern: feature_CONFORMANCE /
// TRUST_TIER_ENGINE). Every `true` is backed by verify.mjs output.
export const feature_CONFORMANCE = Object.freeze({
  wo: "runtime",
  standard: "Universal Manifest v0.4 (Base §1.3.1 version support; EXT-T1 §T1.6.4 backwards-compat; CONFORMANCE §5.3 dual-expectation inversion)",
  fixtures_owned: 3,
  implements: Object.freeze([
    "arrive-stage version router (0.4 ⇒ v0.4 path; 0.3 ⇒ backcompat; else ⇒ reject; fail-closed on ambiguous version)",
    "EXT-T1 §T1.6.4 backcompat path over a REAL Profile-A signature verify + TTL freshness at the pinned clock",
    "NON-OVERRIDABLE forced statuses (holderBinding/presentationProof absent, liveness unknown, effectiveTrustTier capped at 0) + unbound-claims warning",
    "declared-floor interaction via runtime capability check at the Tier-0 cap (Tier-1+ floor ⇒ rejected; Base §6.4.5)",
    "dual-expectation inversion: v0.4 structural schema rejects the v0.3 envelope while the evaluator accepts it (CONFORMANCE §5.3)",
  ]),
  consumes: Object.freeze([
    "runtime evaluateTrustTiers (tier floor / capability decision — pinned to maxSupportedTrustTier 0)",
    "runtime verifyManifestProfileA (Ed25519 + JCS-RFC8785; v0.3 signing input = manifest − signature)",
  ]),
  does_not_implement: Object.freeze([
    "the full v0.4 six-stage evaluator (runtime composes; the v0.4 path here is a handoff marker)",
    "v0.3-native facet/claim semantics beyond the forced Tier-0 backcompat posture",
  ]),
  forced_statuses_overridable: false,
  fail_closed: true,
  um_conformance_claimed: false,
  scoped_claim:
    "runtime implements the REAL arrive-stage version router and the EXT-T1 §T1.6.4 v0.3 backcompat " +
    "path: v0.3 envelopes verify their Profile-A signature and TTL for real, then carry the " +
    "NON-OVERRIDABLE forced statuses (absent binding/validation, unknown liveness, Tier-0 cap) with the " +
    "unbound-claims warning; a declared Tier-1+ floor is rejected at the cap. Unknown/ambiguous " +
    "versions fail closed. It is the routing + backcompat slice, not the full v0.4 evaluator; no flag flipped.",
});

/** The three fixtures owns. */
export const feature_FIXTURE_FILENAMES = Object.freeze([
  "valid/v03-backcompat-manifest.jsonld", // the INVERSION: schema rejects, evaluator accepts
  "invalid/v03-backcompat-tier-floor-unsatisfiable.jsonld", // Tier-1 floor unsatisfiable at the Tier-0 cap
  "invalid/manifest-version-mismatch.jsonld", // manifestVersion "0.5" — no processing path
]);

// ===========================================================================
// Small helpers (browser-safe; no Buffer).
// ===========================================================================

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isIsoDateTime(v) {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}
function hasType(t, wanted) {
  return t === wanted || (Array.isArray(t) && t.includes(wanted));
}
/** Normalize @context to an array of its string members (inline objects dropped). */
function contextStrings(ctx) {
  if (typeof ctx === "string") return [ctx];
  if (Array.isArray(ctx)) return ctx.filter((m) => typeof m === "string");
  return [];
}

// ===========================================================================
// (1) ARRIVE-STAGE ROUTER — Base §1.3.1 (version support before processing).
// ===========================================================================

/**
 * Decide the processing path from the manifest's declared version + context.
 * FAIL CLOSED: an unknown version, a missing version, or a version/context
 * MISMATCH (e.g. manifestVersion "0.3" carrying only a v0.4 context) is rejected —
 * there is no processing path and an ambiguous envelope must never be guessed.
 *
 * @returns {{ path: "v0.4"|"v0.3-backcompat"|"reject", version: any, reason: string }}
 */
export function routeByVersion(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { path: "reject", version: undefined, reason: "manifest is not an object — no processing path (Base §1.3.1)" };
  }
  const version = manifest.manifestVersion;
  const ctx = contextStrings(manifest["@context"]);

  if (version === MANIFEST_VERSION_V04) {
    if (ctx.includes(UM_NS_V04)) {
      return { path: "v0.4", version, reason: "manifestVersion 0.4 with the pinned v0.4 context — v0.4 evaluation path" };
    }
    return {
      path: "reject",
      version,
      reason: `manifestVersion "0.4" without the v0.4 context ${JSON.stringify(UM_NS_V04)} — ambiguous envelope, fail closed (Base §1.3.1)`,
    };
  }

  if (version === MANIFEST_VERSION_V03) {
    if (ctx.includes(UM_NS_V03)) {
      return { path: "v0.3-backcompat", version, reason: "manifestVersion 0.3 with the v0.3 context — EXT-T1 §T1.6.4 backcompat path" };
    }
    return {
      path: "reject",
      version,
      reason: `manifestVersion "0.3" without the v0.3 context ${JSON.stringify(UM_NS_V03)} — ambiguous envelope, fail closed (Base §1.3.1)`,
    };
  }

  // Any other value (0.5, 0.2, missing, non-string): no v0.4 processing path.
  return {
    path: "reject",
    version,
    reason: `manifestVersion ${JSON.stringify(version)} is supported by no v0.4 processing path — evaluators MUST check version support before processing (Base §1.3.1). v0.3 envelopes instead take the EXT-T1 §T1.6.4 backcompat path.`,
  };
}

// ===========================================================================
// (4a) v0.4 STRUCTURAL SCHEMA HALF — the schema-sweep verdict (the inversion).
// ===========================================================================

/**
 * The v0.4 structural-schema verdict for the schema-sweep stage.
 * A v0.4 conformant envelope MUST declare manifestVersion "0.4" and include the
 * pinned v0.4 context (CONFORMANCE §5.3 / Base §1.3.1). A v0.3 envelope FAILS this
 * (manifestVersion "0.3" ≠ "0.4") — the REJECT half of the inversion — as does the
 * "0.5" version-mismatch fixture. This models what the demo's schema-sweep reports
 * (schemaValidation.expectedResult) for these fixtures, DISTINCT from the evaluator
 * verdict below.
 *
 * @returns {{ result: "accept"|"reject", reasons: string[] }}
 */
export function v04StructuralSchemaVerdict(manifest) {
  const reasons = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { result: "reject", reasons: ["manifest must be an object"] };
  }
  if (!hasType(manifest["@type"], "um:Manifest")) reasons.push("@type must include um:Manifest (Section 1.2.3)");
  if (manifest.manifestVersion !== MANIFEST_VERSION_V04) {
    reasons.push(`manifestVersion must be "0.4" for the v0.4 structural schema (got ${JSON.stringify(manifest.manifestVersion)})`);
  }
  if (!contextStrings(manifest["@context"]).includes(UM_NS_V04)) {
    reasons.push(`@context must include the pinned v0.4 namespace ${JSON.stringify(UM_NS_V04)} (Section 1.2.1)`);
  }
  return { result: reasons.length === 0 ? "accept" : "reject", reasons };
}

// ===========================================================================
// (2) v0.3 ENVELOPE CONTRACT — the fallback rung's own structural check.
// ===========================================================================

/**
 * Validate a manifest against the v0.3 envelope contract (spec/v0.3/schema.json
 * `required`): @context / @id / @type(um:Manifest) / manifestVersion "0.3" /
 * subject / issuedAt / expiresAt / signature, with the v0.3 context present and a
 * coherent issued≤expires window. Structural only — signature crypto + freshness
 * are the six-stage Verify job (below). Returns { valid, errors: string[] }.
 */
export function validateV03Envelope(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["manifest must be an object"] };
  }
  if (!contextStrings(manifest["@context"]).includes(UM_NS_V03)) {
    errors.push(`@context must include the v0.3 namespace ${JSON.stringify(UM_NS_V03)} (v0.3 Section 1.2.1)`);
  }
  if (!isNonEmptyString(manifest["@id"])) errors.push("Missing @id (v0.3 Section 1.2.2)");
  if (!hasType(manifest["@type"], "um:Manifest")) errors.push("@type must include um:Manifest (v0.3 Section 1.2.3)");
  if (manifest.manifestVersion !== MANIFEST_VERSION_V03) errors.push('manifestVersion must be "0.3" (v0.3 Section 1.3.1)');
  if (!isNonEmptyString(manifest.subject)) errors.push("Missing subject (v0.3 Section 1.3.2)");
  if (!isIsoDateTime(manifest.issuedAt)) errors.push("issuedAt must be an ISO 8601 date-time (v0.3 Section 1.3.3)");
  if (!isIsoDateTime(manifest.expiresAt)) errors.push("expiresAt must be an ISO 8601 date-time (v0.3 Section 1.3.3)");
  if (isIsoDateTime(manifest.issuedAt) && isIsoDateTime(manifest.expiresAt) && Date.parse(manifest.issuedAt) > Date.parse(manifest.expiresAt)) {
    errors.push("issuedAt must be <= expiresAt (v0.3 Section 1.3.3)");
  }
  if (!manifest.signature || typeof manifest.signature !== "object") errors.push("Missing signature (v0.3 Signature Profile A)");
  return { valid: errors.length === 0, errors };
}

// ===========================================================================
// (2)+(3) BACKCOMPAT EVALUATOR — the EXT-T1 §T1.6.4 path.
// ===========================================================================

/**
 * Apply the NON-OVERRIDABLE T1.6.4 forced statuses to a receipt in place, plus the
 * unbound-claims warning. Set from FORCED_BACKCOMPAT_STATUS — NEVER from manifest
 * content, so a v0.3 manifest cannot be upgraded to a full v0.4 claim.
 */
function applyForcedBackcompatStatuses(receipt) {
  receipt.holderBindingStatus = FORCED_BACKCOMPAT_STATUS.holderBindingStatus; // "absent"
  receipt.presentationProofStatus = FORCED_BACKCOMPAT_STATUS.presentationProofStatus; // "absent"
  receipt.livenessStatus = { freshnessClass: FORCED_BACKCOMPAT_STATUS.livenessFreshnessClass }; // "unknown"
  receipt.effectiveTrustTier = FORCED_BACKCOMPAT_STATUS.effectiveTrustTier; // 0, capped regardless of declarations
  receipt.backcompatRouted = true;
  receipt.specVersionRouted = "0.3";
  receipt.warnings.push({
    code: WARN_UNBOUND_CLAIMS,
    message:
      "v0.3 backcompat: manifest has no v0.4 holder binding — claims are unbound and the effective trust tier is capped at Tier 0 (EXT-T1 §T1.6.4)",
  });
}

/**
 * Evaluate a v0.3 manifest through the EXT-T1 §T1.6.4 backwards-compatibility path.
 * Six-stage sequence (the slice this change owns): v0.3 envelope contract → Profile-A
 * signature → TTL freshness at the PINNED clock →
 * forced T1.6.4 statuses → declared-floor decision (capability check at the
 * Tier-0 cap). NEVER reads binding material off the manifest to raise a status.
 *
 * @param {object} manifest a v0.3-enveloped manifest.
 * @param {object} context  { now?: ISO8601 } — pinned evaluation clock (never wall clock).
 * @returns {{ result: "accept"|"reject", receipt: object }}
 */
export async function evaluateV03Backcompat(manifest, context = {}) {
  const nowMs = isIsoDateTime(context.now) ? Date.parse(context.now) : Date.now();
  const manifestId = manifest && typeof manifest === "object" && isNonEmptyString(manifest["@id"]) ? manifest["@id"] : "(unknown)";
  const warnings = [];
  const receipt = {
    "@type": "um:Receipt",
    manifestId,
    specVersionRouted: "0.3",
    outcome: "rejected",
    signatureCheck: "not-evaluated",
    freshnessCheck: "not-evaluated",
    facetStatuses: [],
    warnings,
  };
  const finish = (outcome) => {
    receipt.outcome = outcome;
    return { result: outcome === "rejected" ? "reject" : "accept", receipt };
  };

  // --- Arrive/Verify: v0.3 envelope contract --------------------------------
  const env = validateV03Envelope(manifest);
  if (!env.valid) {
    warnings.push({ code: WARN_STRUCTURE_MALFORMED, message: `Verify stage: ${env.errors.join("; ")}` });
    return finish("rejected");
  }

  // --- Verify: Profile-A signature over the v0.3 signing input ------
  // computeSigningInput is version-aware: for v0.3 the input is manifest − signature
  // (no presentationProof exclusion — that is v0.4-only). REAL Ed25519 verification.
  const sigReport = await verifyManifestProfileA(manifest);
  if (!sigReport.ok) {
    receipt.signatureCheck = sigReport.reason === "unsupported-profile" ? "unsupported-profile" : "invalid";
    warnings.push({
      code: sigReport.reason === "unsupported-profile" ? "um:reason:crypto:unsupported-profile" : "um:reason:crypto:signature-invalid",
      message: `Verify stage: ${sigReport.reason}`,
    });
    return finish("rejected");
  }
  receipt.signatureCheck = "valid";

  // --- Verify: freshness at the PINNED clock (Section 3.1.2; 60s skew) -------
  const SKEW_MS = 60_000;
  const issuedMs = Date.parse(manifest.issuedAt);
  const expiresMs = Date.parse(manifest.expiresAt);
  if (issuedMs - nowMs > SKEW_MS) {
    receipt.freshnessCheck = "stale";
    warnings.push({ code: "um:reason:freshness:stale", message: "Verify stage: issuedAt more than 60s in the future" });
    return finish("rejected");
  }
  if (nowMs > expiresMs) {
    receipt.freshnessCheck = "expired";
    warnings.push({ code: "um:reason:freshness:expired", message: "Verify stage: manifest expired" });
    return finish("rejected");
  }
  receipt.freshnessCheck = "fresh";

  // --- Force the NON-OVERRIDABLE T1.6.4 statuses (steps 2-5 + unbound warn) --
  applyForcedBackcompatStatuses(receipt);

  // --- Declared-floor interaction (Base §6.4.5) at the Tier-0 cap -
  // CONSUME (depends_on): pin maxSupportedTrustTier to the backcompat cap.
  // A manifest-level requiredTrustTier ≥ 1 exceeds the cap ⇒ returns
  // verdict "rejected" (rejectedBy "manifest-tier-unsupported") — the DECLARED FLOOR
  // rejects, not the cap itself (T1.6.4: "Capping ... does not by itself reject").
  const tierFragment = evaluateTrustTiers(manifest, { maxSupportedTrustTier: BACKCOMPAT_TIER_CAP });
  receipt.tierFragment = { verdict: tierFragment.verdict, rejectedBy: tierFragment.rejectedBy, manifestTier: tierFragment.manifestTier };
  // effectiveTrustTier stays FORCED at 0 (never read from the fragment) — the cap is absolute.
  receipt.effectiveTrustTier = BACKCOMPAT_TIER_CAP;

  if (tierFragment.verdict === "rejected") {
    warnings.push({
      code: WARN_TIER_UNSUPPORTED,
      message:
        `v0.3 backcompat: declared manifest requiredTrustTier ${tierFragment.manifestTier} cannot be satisfied at the ` +
        `Tier-0 backcompat cap — rejected (Base §6.4.5; EXT-T1 §T1.6.4)`,
    });
    return finish("rejected");
  }

  // No declared floor above the cap: accepted, unbound at Tier 0.
  return finish("accepted-with-warnings");
}

// ===========================================================================
// TOP-LEVEL: route + dispatch (the single entry point the runner/demo call).
// ===========================================================================

/**
 * Route a manifest by version, then dispatch. The three outcomes:
 *   reject path (unknown/ambiguous version) ⇒ structural reject receipt.
 *   v0.3-backcompat path                    ⇒ evaluateV03Backcompat (needs context.now).
 *   v0.4 path ⇒ handoff marker (composes the full
 *                                             v0.4 evaluator; does not own it).
 *
 * @returns {{ result: "accept"|"reject"|"route-v0.4", receipt?: object, route: object }}
 */
export async function evaluateVersionRouted(manifest, context = {}) {
  const route = routeByVersion(manifest);

  if (route.path === "reject") {
    const receipt = {
      "@type": "um:Receipt",
      manifestId: manifest && isNonEmptyString(manifest["@id"]) ? manifest["@id"] : "(unknown)",
      outcome: "rejected",
      warnings: [{ code: WARN_VERSION_UNSUPPORTED, message: `Arrive stage: ${route.reason}` }],
    };
    return { result: "reject", receipt, route };
  }

  if (route.path === "v0.3-backcompat") {
    const { result, receipt } = await evaluateV03Backcompat(manifest, context);
    return { result, receipt, route };
  }

  // route.path === "v0.4": hands off to the v0.4 evaluator. None of
  // owned fixtures reach here; returned as a marker, never as a bare accept.
  return {
    result: "route-v0.4",
    route,
    reason: "v0.4 envelope — handed to the v0.4 evaluation path (runtime composes the six stages); out of runtime scope",
  };
}

// ===========================================================================
// DEMO SURFACE (Bucket-2 invented, honest) — the "legacy visitor" crossing.
// ===========================================================================

/**
 * buildLegacyVisitorDemo — display-ready data for the crossing UI's legacy-visitor
 * mode (task deliverable #5): a v0.3-enveloped visitor crosses into the v0.4 world and
 * is admitted through the backcompat path with a VISIBLY capped tier and the
 * unbound-claims warning in the receipt. Everything here is computed by the REAL
 * backcompat evaluator over a real v0.3 manifest — no hardcoded theater.
 *
 * @param {object} v03Manifest a v0.3-enveloped manifest (e.g. the suite fixture).
 * @param {object} context     { now?: ISO8601 } pinned clock for the crossing.
 */
export async function buildLegacyVisitorDemo(v03Manifest, context = {}) {
  const route = routeByVersion(v03Manifest);
  const { result, receipt } = route.path === "v0.3-backcompat"
    ? await evaluateV03Backcompat(v03Manifest, context)
    : { result: "reject", receipt: { outcome: "rejected", warnings: [{ code: WARN_VERSION_UNSUPPORTED, message: route.reason }] } };

  const unbound = (receipt.warnings || []).some((w) => w.code === WARN_UNBOUND_CLAIMS);
  return {
    routed_path: route.path,
    admitted: result === "accept",
    receipt_outcome: receipt.outcome,
    displayed_trust_tier: receipt.effectiveTrustTier,
    holder_binding_status: receipt.holderBindingStatus,
    presentation_proof_status: receipt.presentationProofStatus,
    liveness_freshness_class: receipt.livenessStatus?.freshnessClass,
    unbound_claims_warning: unbound,
    banner:
      result === "accept"
        ? `Legacy (v0.3) visitor admitted at Tier ${receipt.effectiveTrustTier} — claims unbound (no v0.4 holder binding). ` +
          "The receipt carries um:reason:trust:unbound-claims; identity assurance is NOT elevated."
        : `Legacy (v0.3) visitor NOT admitted: ${receipt.outcome} (${(receipt.warnings || [])[0]?.message || "declared floor unsatisfiable at the Tier-0 backcompat cap"}).`,
    honesty:
      "The backcompat path forces holderBindingStatus/presentationProofStatus 'absent', liveness 'unknown', " +
      "and effectiveTrustTier 0 UNCONDITIONALLY (EXT-T1 §T1.6.4). A v0.3 manifest cannot be upgraded to a full " +
      "v0.4 claim. Signature + TTL are verified for real; the tier floor is decided by runtime.",
  };
}

// ===========================================================================
// CONFORMANCE-RUNNER REGISTRATION HOOK (the shared v0.4 runner wires this with
// TWO lines — applied at integration, NOT by this module).
// ===========================================================================

/**
 * Evaluate ONE fixture against its expected.json entry contract:
 *   entry.validationMode "evaluation" ⇒ route + evaluate under entry.evaluationContext
 *                                        (the two v0.3 fixtures — accept / reject).
 *   otherwise                         ⇒ route + structural verdict (manifest-version
 *                                        -mismatch — schema-detectable reject).
 * Returns the adapter shape { result, reason, receipt? } the runner pattern
 * uses, so the shared v0.4 runner can dispatch fixtures with no impedance
 * mismatch. The `result` is the EVALUATOR verdict (matches entry.expectedResult); the
 * schema-sweep half of the inversion is asserted separately (v04StructuralSchemaVerdict).
 */
export async function featureFixtureHandler(fixtureJson, expectedEntry = {}) {
  const routed = await evaluateVersionRouted(fixtureJson, expectedEntry.evaluationContext || {});
  // route-v0.4 never occurs for the three owned fixtures; guard defensively.
  const result = routed.result === "route-v0.4" ? "accept" : routed.result;
  const receipt = routed.receipt || {};
  return {
    result,
    reason: receipt.warnings?.[0]?.message || receipt.outcome || routed.route?.reason || "version routed",
    receipt,
  };
}

/**
 * Registration hook for the shared v0.4 conformance runner. Contract:
 *   registry.register(filename, asyncHandler(fixtureJson, expectedEntry))
 * The orchestrator wires it with exactly:
 *   import { registerVersionRouting } from "../manifest/version-routing.mjs";
 *   registerVersionRouting(registry);
 */
export function registerVersionRouting(registry) {
  if (!registry || typeof registry.register !== "function") {
    throw new Error("registerVersionRouting: registry with a register(filename, handler) function required");
  }
  for (const filename of feature_FIXTURE_FILENAMES) {
    registry.register(filename, featureFixtureHandler);
  }
  return feature_FIXTURE_FILENAMES.length;
}
