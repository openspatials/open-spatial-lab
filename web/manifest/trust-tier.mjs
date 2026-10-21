// Universal Manifest v0.4 trust-tier enforcement engine.
//
// This module owns the v0.4 TIER logic — nothing else. It is the load-bearing Base
// behavior that..129 left unowned and that (entity-type/
// personhood), (ZKP/ceremony), (bilateral session), and
// (version routing / v0.3 backcompat) all build on:
//
//   1. FLOOR VALIDATION (raise-only). A claim- or facet-level `requiredTrustTier`
//      LOWER than the manifest-level floor is a cross-field structural violation and
//      the manifest MUST be rejected. Floors raise only. (Base §6.4.5; CONFORMANCE
//      §2.12; adversarial §6.3 "trust-tier downgrade attempts".) This is an
//      EVALUATOR-ONLY check — the JSON Schema cannot express it (expected.json
//      classifies both floor fixtures `evaluator-only`).
//   2. CAPABILITY CHECK (no-downgrade). A required tier above the evaluator's
//      `maxSupportedTrustTier` makes the item UNVERIFIABLE: record
//      `trustTierUnsupported` (claimStatuses / facetStatuses), NEVER downgrade to a
//      lower tier, outcome `accepted-partial` where other items can still be
//      processed, `rejected` when the unsupported tier applies at the MANIFEST level.
//      (Base §6.4.5; CONFORMANCE §2.15; conformance/README `evaluationContext.
//      maxSupportedTrustTier`.)
//   3. TIER-0 CAPPING. A claim relied upon at Tier 1+ without a verified holder
//      binding is capped at Tier 0: `holderBindingStatus: "absent"` (missing) or
//      `"failed"` (failed verification), `effectiveTrustTier: 0`, claim recorded
//      `trustTierUnsupported` with `tier: 0`. (CONFORMANCE §2.9; adversarial §6.1
//      "holder-binding bypass"; EXT-T1 §T1.0/T1.1.)
//   4. RECEIPT FIELDS. Computes `effectiveTrustTier` — "the highest trust tier the
//      evaluator actually verified for the claims it relied on" (Base §3.3.1.1) —
//'s structured receipt to consume.
//   5. BILATERAL NEGOTIATED FLOOR. The interaction tier floor of an exchange is the
//      MAX of both parties' `requiredTrustTier` — a negotiated floor, DISTINCT from
//      the `effectiveTrustTier` each party verifies and records (CONFORMANCE §1/§4;
//      Base §6.4.6). Exported and the crossing-UI demo surface.
//
// SEMANTICS ARE PINNED TO THE REFERENCE IMPLEMENTATION (the code that produced
// conformance/v0.4/expected.json):
// universal-manifest/src/index.ts (evaluateUniversalManifestV04, lines ~3136-3423).
// The subtle, fixture-pinned details this engine reproduces exactly:
//
//   - Per-item floor merge is RAISE-ONLY: itemTier = max(manifestTier, item tier ?? 0).
//   - ORDER OF CLAIM CHECKS: capability BEFORE binding-cap BEFORE claim-type
//     processing. A Tier-2 claim on a Tier-1 evaluator records
//     {status: "trustTierUnsupported", tier: <maxSupportedTrustTier>} — tier is the
//     evaluator's CAPABILITY BOUNDARY, not 0, and the binding cap is never reached
//     (the claim is never relied upon at all). Fixture: valid/
//     claim-tier-unsupported-by-evaluator.jsonld → tier: 1 under max=1.
//   - The BINDING CAP records {status: "trustTierUnsupported", tier: 0} AND sets the
//     receipt-level holderBindingStatus + effectiveTrustTier: 0. Fixture: valid/
//     claim-tier-cap-no-holder-binding.jsonld → tier: 0, holderBindingStatus
//     "absent", effectiveTrustTier 0. The cap takes precedence over unrecognized-
//     claim-type handling (that fixture's @type is unrecognized yet records the CAP
//     status, not "unprocessable") — composing evaluators MUST keep this order.
//   - "Binding material PRESENT" (a holderBinding, bindingProof, or ceremonyProof
//     member) avoids the CAP RECORD but contributes NOTHING above Tier 0 to
//     effectiveTrustTier unless a verifier reports it VERIFIED. No
//     silent uplift: presence ≠ verification.
//   - MANIFEST-LEVEL unsupported tier → outcome `rejected`, every projected facet
//     recorded trustTierUnsupported, warning code `um:reason:trust:tier-unsupported`.
//   - FLOOR VIOLATION → structural reject; in evaluation mode the composed receipt is
//     `rejected` with warning code `um:reason:structure:malformed` and signatureCheck
//     "not-evaluated" (a Verify-stage structural failure — the reference rejects it
//     inside assertUniversalManifestV04 before any signature/freshness math).
//
// ---------------------------------------------------------------------------
// SCOPE / HONESTY (read before touching the labels)
// ---------------------------------------------------------------------------
// IMPLEMENTED FOR REAL here: raise-only floor validation, capability check with the
// no-downgrade invariant, Tier-0 capping with absent/failed binding statuses,
// effectiveTrustTier computation, bilateral negotiated-floor math. All fail CLOSED.
//
// NOT implemented here (seams, honestly labeled):
//   - HOLDER-BINDING VERIFICATION (sd-jwt-kb / bbs-holder-commitment /
//     reciprocal-control mechanics) =. This engine takes an injectable
//     `holderBindingStatusOf(claim, manifest)` provider; the DEFAULT provider is
//     PRESENCE-BASED ONLY ("absent" when no binding member exists,
//     "present-unverified" otherwise — never "verified"). injects real
//     verification results ("verified"/"failed").
//   - TIER-2 ZKP / TIER-3 CEREMONY verification profiles = (Grade-1
//     structural PREVIEW). Unimplemented tiers FAIL CLOSED via the capability check:
//     required tier > maxSupportedTrustTier → trustTierUnsupported, never downgraded.
//   - Signature/freshness verification, consent, projection
//the composed six-stage receipt. This engine returns a
//     RECEIPT FRAGMENT for the composing evaluator, not a full um:Receipt.
// This module flips NO um_conformance flag.
//
// Zero dependencies; plain ESM (.mjs) — imports cleanly in Node and the browser,
// like the sibling modules.

// ===========================================================================
// Tier constants (spec/v0.4/schema.json $defs.trustTier: integer 0..3, default 0).
// ===========================================================================
export const TRUST_TIER_MIN = 0;
export const TRUST_TIER_MAX = 3;

/** The spec default when a `requiredTrustTier` member is absent (schema: "Default 0"). */
export const TRUST_TIER_DEFAULT = 0;

/**
 * The demo evaluator's capability ceiling. Tier 1 is the HONEST value for this demo:
 * Tier-0 (signature verification) is real and Tier-1 binding checks have
 * an owner; Tier-2 ZKP and Tier-3 ceremony verification profiles are NOT
 * implemented and MUST record trustTierUnsupported.
 * The conformance runner pins this per-fixture via evaluationContext (matrix uses 0 and 1).
 */
export const DEFAULT_MAX_SUPPORTED_TRUST_TIER = 1;

/** Warning codes (aligned with the reference implementation's reason registry). */
export const WARN_TIER_UNSUPPORTED = "um:reason:trust:tier-unsupported";
export const WARN_STRUCTURE_MALFORMED = "um:reason:structure:malformed";

/** Holder-binding status vocabulary this engine consumes/records (EXT-T1 §T1.1). */
export const BINDING_VERIFIED = "verified";
export const BINDING_FAILED = "failed";
export const BINDING_ABSENT = "absent";
/** Binding material present on the claim but NOT verified by any engine (default provider). */
export const BINDING_PRESENT_UNVERIFIED = "present-unverified";

/** True when v is a valid trust tier (integer 0..3). */
export function isTrustTier(v) {
  return Number.isInteger(v) && v >= TRUST_TIER_MIN && v <= TRUST_TIER_MAX;
}

/** Coerce an optional declared tier to its effective value (absent → 0 per schema). */
function tierOrDefault(v) {
  return isTrustTier(v) ? v : TRUST_TIER_DEFAULT;
}

// ===========================================================================
// (1) RAISE-ONLY floor math + validation (Base §6.4.5; CONFORMANCE §2.12, §6.3).
// ===========================================================================

/**
 * The raise-only floor merge: the tier that governs an item is the manifest floor
 * RAISED (never lowered) by the item's own declaration.
 * effectiveFloor(m, i) === max(m, i ?? 0). Monotone: result >= both inputs' effective values.
 */
export function effectiveFloor(manifestTier, itemTier) {
  return Math.max(tierOrDefault(manifestTier), tierOrDefault(itemTier));
}

/**
 * checkFloors(manifest) — the §6.4.5 cross-field structural check. A claim- or
 * facet-level `requiredTrustTier` LOWER than the manifest-level floor is a
 * structural violation: the manifest MUST be rejected (floors raise only).
 *
 * This is evaluator-only (the JSON Schema accepts these manifests — tier
 * comparison is not schema-expressible): fixtures invalid/claim-tier-below-
 * manifest-floor.jsonld and invalid/facet-tier-below-manifest-floor.jsonld.
 *
 * Returns { ok, manifestTier, violations: [{ kind, index, ref, declaredTier,
 * manifestTier, reason }] }. Reasons carry the reference implementation's
 * diagnostic substrings (fixtures' __expectedError values) so cross-harness
 * triage reads identically; external implementations are not required to match
 * the text — the verdict is what conformance pins.
 *
 * NOTE: the v0.3-backcompat unsatisfiable-floor path re-uses the
 * CAPABILITY check (a Tier-1+ floor at the backcompat Tier-0 cap), NOT this
 * floor-violation check — see evaluateTrustTiers()' manifest-level branch.
 */
export function checkFloors(manifest) {
  const m = manifest && typeof manifest === "object" ? manifest : {};
  const manifestTier = tierOrDefault(m.requiredTrustTier);
  const violations = [];

  const claims = Array.isArray(m.claims) ? m.claims : [];
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i] && typeof claims[i] === "object" ? claims[i] : {};
    const declared = c.requiredTrustTier;
    if (isTrustTier(declared) && declared < manifestTier) {
      violations.push({
        kind: "claim",
        index: i,
        ref: refOf(c),
        declaredTier: declared,
        manifestTier,
        reason:
          "claim.requiredTrustTier cannot be lower than manifest.requiredTrustTier (Section 6.4.5)",
      });
    }
  }

  const facets = Array.isArray(m.facets) ? m.facets : [];
  for (let i = 0; i < facets.length; i++) {
    const f = facets[i] && typeof facets[i] === "object" ? facets[i] : {};
    const declared = f.requiredTrustTier;
    if (isTrustTier(declared) && declared < manifestTier) {
      violations.push({
        kind: "facet",
        index: i,
        ref: refOf(f),
        declaredTier: declared,
        manifestTier,
        reason:
          "facet.requiredTrustTier cannot be lower than manifest.requiredTrustTier (Section 6.4.5)",
      });
    }
  }

  return { ok: violations.length === 0, manifestTier, violations };
}

// ===========================================================================
// (2)+(3) capTier — the single-claim tier decision (capability + Tier-0 cap).
// ===========================================================================

/**
 * capTier — decide the tier disposition of ONE claim. Pure function; the exact
 * decision order is fixture-pinned (see module header):
 *
 *   1. CAPABILITY: requiredTier (already floor-merged) > maxSupportedTrustTier
 *      → { path: "unsupported", tier: maxSupportedTrustTier }. The recorded tier is
 *      the evaluator's capability BOUNDARY — the claim is unverifiable, NOT relied
 *      upon, and NEVER downgraded (no re-reliance at a lower tier).
 *   2. TIER-0 CAP: requiredTier >= 1 and the holder binding is "absent" or "failed"
 *      → { path: "capped", tier: 0, holderBindingStatus } (CONFORMANCE §2.9/§6.1).
 *   3. Otherwise → { path: "within", tier: requiredTier } — the TIER logic has no
 *      objection; whether the claim VERIFIES is the binding/claim-proof engines' job.
 *
 * @param {object} args
 *   requiredTier            the claim's floor-merged tier (use effectiveFloor()).
 *   maxSupportedTrustTier   evaluator capability ceiling (integer 0..3).
 *   bindingStatus           "verified" | "present-unverified" | "failed" | "absent".
 * @returns {{ path: "unsupported"|"capped"|"within", tier: number,
 *            holderBindingStatus?: "absent"|"failed" }}
 */
export function capTier({ requiredTier, maxSupportedTrustTier, bindingStatus }) {
  const required = tierOrDefault(requiredTier);
  const max = tierOrDefault(maxSupportedTrustTier);

  if (required > max) {
    return { path: "unsupported", tier: max };
  }
  if (required >= 1 && (bindingStatus === BINDING_ABSENT || bindingStatus === BINDING_FAILED)) {
    return { path: "capped", tier: 0, holderBindingStatus: bindingStatus };
  }
  return { path: "within", tier: required };
}

/**
 * DEFAULT holder-binding status provider — PRESENCE-BASED ONLY (the seam).
 * Mirrors the reference implementation's `carriesBindingMaterial` test: a
 * holderBinding, bindingProof, or ceremonyProof member counts as binding material.
 * Returns "present-unverified" (NEVER "verified" — this engine verifies nothing)
 * or "absent". replaces this with real verification ("verified"/"failed").
 */
export function defaultHolderBindingStatusOf(claim /*, manifest */) {
  const c = claim && typeof claim === "object" ? claim : {};
  const present =
    c.holderBinding !== undefined || c.bindingProof !== undefined || c.ceremonyProof !== undefined;
  return present ? BINDING_PRESENT_UNVERIFIED : BINDING_ABSENT;
}

// ===========================================================================
// (4) evaluateTrustTiers — the full tier pass over a manifest.
// ===========================================================================

/**
 * Run the complete v0.4 trust-tier enforcement pass over a manifest and return a
 * RECEIPT FRAGMENT for the composing evaluator. This is the tier
 * engine only — it does NOT verify signatures, freshness, consent, or claim
 * proofs; items with no tier objection are returned as deferred* pass-throughs.
 *
 * @param {object} manifest a v0.4-shaped manifest (or v0.3's router,
 *                           which pins maxSupportedTrustTier to the Tier-0 backcompat cap).
 * @param {object} context
 *   maxSupportedTrustTier   integer 0..3. DEFAULT 0 — FAIL CLOSED: an unconfigured
 *                           evaluator claims NO tier capability (the conformance
 *                           runner always pins this; the demo evaluator passes
 *                           DEFAULT_MAX_SUPPORTED_TRUST_TIER = 1).
 *   holderBindingStatusOf   (claim, manifest) => "verified"|"present-unverified"|
 *                           "failed"|"absent". DEFAULT defaultHolderBindingStatusOf
 *                           (presence-based; the injection seam).
 *
 * @returns {object} receipt fragment:
 *   verdict            "accepted" | "accepted-partial" | "rejected" — the TIER
 *                      engine's outcome contribution (§6.4.5 mapping). "accepted"
 *                      means NO TIER OBJECTION — other engines may still degrade it.
 *   rejectedBy         null | "floor-violation" | "manifest-tier-unsupported"
 *   manifestTier, maxSupportedTrustTier
 *   floorViolations    checkFloors() violations (rejectedBy "floor-violation")
 *   claimStatuses      TIER-OWNED entries only: { claimRef, status:
 *                      "trustTierUnsupported", tier, reason }
 *   facetStatuses      TIER-OWNED entries only: { facetId, name?, status:
 *                      "trustTierUnsupported", reason }
 *   holderBindingStatus  "absent"|"failed" — present ONLY when the Tier-0 cap ran
 *   effectiveTrustTier   integer — present ONLY when defined: 0 when the cap ran,
 *                        else max VERIFIED contribution (min(claimTier, max) per
 *                        verified claim) when a verifier reported one. Mirrors the
 *                        reference: omitted entirely when nothing defines it.
 *   warnings           [{ code, message }] tier-owned warnings
 *   deferredClaims     [{ claimRef, tier, bindingStatus }] claims with NO tier
 *                      objection — claim-type processing (unprocessable/unverified/
 *                      verified) belongs to. TIER PATHS TAKE
 *                      PRECEDENCE: composing evaluators MUST NOT re-status a claim
 *                      this fragment already carries in claimStatuses.
 *   deferredFacetIds   facet @ids with no tier objection (consent/assurance/opaque
 *                      handling belongs to).
 */
export function evaluateTrustTiers(manifest, context = {}) {
  const m = manifest && typeof manifest === "object" ? manifest : {};
  const max = tierOrDefault(context.maxSupportedTrustTier);
  const bindingStatusOf =
    typeof context.holderBindingStatusOf === "function"
      ? context.holderBindingStatusOf
      : defaultHolderBindingStatusOf;

  const fragment = {
    engine: "runtime-trust-tier",
    verdict: "accepted",
    rejectedBy: null,
    manifestTier: tierOrDefault(m.requiredTrustTier),
    maxSupportedTrustTier: max,
    floorViolations: [],
    claimStatuses: [],
    facetStatuses: [],
    warnings: [],
    deferredClaims: [],
    deferredFacetIds: [],
  };

  // ---- (1) RAISE-ONLY floor validation — a violation rejects the manifest -------
  // (structural class: in the composed evaluator this fails the Verify stage before
  // signature/freshness math → signatureCheck "not-evaluated", per the reference).
  const floors = checkFloors(m);
  if (!floors.ok) {
    fragment.verdict = "rejected";
    fragment.rejectedBy = "floor-violation";
    fragment.floorViolations = floors.violations;
    fragment.warnings.push({
      code: WARN_STRUCTURE_MALFORMED,
      message: `Verify stage: ${floors.violations[0].reason}`,
    });
    return fragment;
  }

  const manifestTier = floors.manifestTier;

  // ---- (2) MANIFEST-LEVEL capability check — unsupported at the manifest level ---
  // rejects (§6.4.5: "rejected if the unsupported tier applies at the manifest
  // level"). Every projected facet is recorded trustTierUnsupported. This branch is
  // also v0.3-backcompat unsatisfiable-floor path (Tier-1+ floor, max=0).
  const facets = Array.isArray(m.facets) ? m.facets : [];
  if (manifestTier > max) {
    fragment.verdict = "rejected";
    fragment.rejectedBy = "manifest-tier-unsupported";
    fragment.facetStatuses = facets.map((f) => ({
      facetId: refOf(f),
      ...(typeof f?.name === "string" ? { name: f.name } : {}),
      status: "trustTierUnsupported",
      reason: `manifest requiredTrustTier ${manifestTier} exceeds evaluator capability ${max}`,
    }));
    fragment.warnings.push({
      code: WARN_TIER_UNSUPPORTED,
      message: `Compose stage: manifest-level requiredTrustTier ${manifestTier} exceeds evaluator capability ${max}`,
    });
    return fragment;
  }

  // ---- (2)+(3) per-CLAIM capability + Tier-0 cap (fixture-pinned order) ----------
  const claims = Array.isArray(m.claims) ? m.claims : [];
  let capBindingStatus;
  const verifiedContributions = [];
  for (const claim of claims) {
    const c = claim && typeof claim === "object" ? claim : {};
    const claimRef = refOf(c);
    const claimTier = effectiveFloor(manifestTier, c.requiredTrustTier);
    // N3 (robustness): a holder-binding provider that THROWS must FAIL CLOSED inside
    // the engine — never propagate and crash the composing pipeline. Any provider fault
    // maps to "absent" (the Tier-0 cap value); the fragment stays well-formed and NO
    // claim is ever elevated by a provider that errored. (Adversarial AV-16.)
    let rawBindingStatus;
    try {
      rawBindingStatus = bindingStatusOf(c, m);
    } catch (_providerFault) {
      rawBindingStatus = BINDING_ABSENT;
    }
    const bindingStatus = normalizeBindingStatus(rawBindingStatus);
    const decision = capTier({
      requiredTier: claimTier,
      maxSupportedTrustTier: max,
      bindingStatus,
    });

    if (decision.path === "unsupported") {
      // §6.4.5: no implemented verification profile for the required tier — treat as
      // unverifiable, record trustTierUnsupported at the capability boundary, NEVER
      // downgrade (the claim is not re-relied at a lower tier; it is simply not relied on).
      fragment.claimStatuses.push({
        claimRef,
        status: "trustTierUnsupported",
        tier: decision.tier,
        reason: `claim requiredTrustTier ${claimTier} exceeds evaluator capability ${max} (Section 6.4.5)`,
      });
      continue;
    }

    if (decision.path === "capped") {
      // EXT-T1 §T1.0/T1.1 (CONFORMANCE §2.9/§6.1): relied upon at Tier 1+ without a
      // verified holder binding — capped at Tier 0. Records the receipt-level
      // holderBindingStatus ("absent"|"failed") and effectiveTrustTier 0.
      fragment.claimStatuses.push({
        claimRef,
        status: "trustTierUnsupported",
        tier: 0,
        reason:
          bindingStatus === BINDING_FAILED
            ? "claim relied upon at Tier 1+ has a FAILED holder binding — capped at Tier 0 (EXT-T1 Section T1.1)"
            : "claim relied upon at Tier 1+ carries no holderBinding — capped at Tier 0 (EXT-T1 Section T1.1)",
      });
      // N2 (fidelity): the receipt-level holderBindingStatus summary is MOST-SEVERE-WINS,
      // not last-write-wins, so a trailing "absent" never masks an earlier "failed" (an
      // active-attack signal) at the summary level. Per-claim reasons already distinguish
      // them; the tier stays 0 either way. Mirrors the hub's severity-ranked merge.
      // (Adversarial AV-07.)
      capBindingStatus = moreSevereBindingStatus(capBindingStatus, decision.holderBindingStatus);
      continue;
    }

    // path === "within": the tier logic has no objection.
    // N1 (honesty): the DEFAULT presence-based provider maps EMPTY binding material
    // (holderBinding:{}, bindingProof:{}, ceremonyProof:{}) to "present-unverified",
    // which would silently DEFER the claim — upgrading the verdict accepted-partial →
    // accepted and hiding the Tier-0 cap — even though nothing was actually verified.
    // When the DEFAULT provider saw ONLY empty binding material on a Tier-1+ claim,
    // record a VISIBLE present-unverified marker at Tier 0 instead of deferring, so the
    // engine stays honest if misused standalone (without). This is NOT a numeric
    // cap: no effectiveTrustTier/holderBindingStatus summary is set — real verification
    // is still deferred to (which will fail the empty binding). An INJECTED
    // verifier's "present-unverified" verdict is authoritative and left to the composing
    // evaluator untouched. (Adversarial AV-04.)
    if (
      bindingStatusOf === defaultHolderBindingStatusOf &&
      bindingStatus === BINDING_PRESENT_UNVERIFIED &&
      claimTier >= 1 &&
      hasOnlyEmptyBindingMaterial(c)
    ) {
      fragment.claimStatuses.push({
        claimRef,
        status: "trustTierUnsupported",
        tier: 0,
        holderBindingStatus: BINDING_PRESENT_UNVERIFIED,
        reason:
          "claim relied upon at Tier 1+ carries EMPTY holder-binding material — present but " +
          "UNVERIFIED; recorded at Tier 0 pending holder-binding verification, NOT relied upon (EXT-T1 Section T1.1)",
      });
      continue;
    }
    if (bindingStatus === BINDING_VERIFIED) {
      // A verifier reported this claim's binding VERIFIED: it can be
      // relied on, contributing up to its tier, never above the evaluator ceiling.
      verifiedContributions.push(Math.min(claimTier, max));
    }
    fragment.deferredClaims.push({ claimRef, tier: claimTier, bindingStatus });
  }

  // ---- (2) per-FACET capability check --------------------------------------------
  for (const facet of facets) {
    const f = facet && typeof facet === "object" ? facet : {};
    const facetTier = effectiveFloor(manifestTier, f.requiredTrustTier);
    if (facetTier > max) {
      fragment.facetStatuses.push({
        facetId: refOf(f),
        ...(typeof f.name === "string" ? { name: f.name } : {}),
        status: "trustTierUnsupported",
        reason: `facet requiredTrustTier ${facetTier} exceeds evaluator capability ${max}`,
      });
    } else {
      fragment.deferredFacetIds.push(refOf(f));
    }
  }

  // ---- (4) receipt fields (Base §3.3.1.1) ------------------------------------------
  // effectiveTrustTier = highest tier ACTUALLY VERIFIED among relied-on claims. The
  // Tier-0 cap DEFINES it at 0; verified contributions raise it
  // — but never above maxSupportedTrustTier. When nothing defines it, it is OMITTED
  // (reference parity; "absence is equivalent to absent", Base §3.3.1.1).
  if (capBindingStatus !== undefined) {
    fragment.holderBindingStatus = capBindingStatus;
    fragment.effectiveTrustTier =
      verifiedContributions.length > 0 ? Math.max(0, ...verifiedContributions) : 0;
  } else if (verifiedContributions.length > 0) {
    fragment.effectiveTrustTier = Math.max(...verifiedContributions);
  }

  // ---- outcome contribution (§6.4.5 / reference Stage-5 mapping) -------------------
  const hasUnsupported =
    fragment.claimStatuses.some((s) => s.status === "trustTierUnsupported") ||
    fragment.facetStatuses.some((s) => s.status === "trustTierUnsupported");
  fragment.verdict = hasUnsupported ? "accepted-partial" : "accepted";

  return fragment;
}

/** Clamp unknown provider outputs to the fail-closed value ("absent"). */
function normalizeBindingStatus(v) {
  return v === BINDING_VERIFIED ||
    v === BINDING_PRESENT_UNVERIFIED ||
    v === BINDING_FAILED ||
    v === BINDING_ABSENT
    ? v
    : BINDING_ABSENT;
}

/**
 * N2 — dominance order for the RECEIPT-LEVEL holderBindingStatus summary, most severe
 * first: failed ≻ unsupported-mode ≻ absent ≻ present-unverified ≻ verified. Used to
 * merge the cap statuses of multiple claims MOST-SEVERE-WINS so a trailing "absent"
 * never masks an earlier "failed" at the summary line (per-claim reasons already keep
 * both). Mirrors the hub's severity-ranked merge; this is 's OWN summary.
 * (The engine's cap path only ever emits "absent"/"failed"; the wider table is
 * forward-compatible and harmless.)
 */
const BINDING_STATUS_SEVERITY = Object.freeze({
  [BINDING_FAILED]: 4,
  "unsupported-mode": 3,
  [BINDING_ABSENT]: 2,
  [BINDING_PRESENT_UNVERIFIED]: 1,
  [BINDING_VERIFIED]: 0,
});
function moreSevereBindingStatus(current, next) {
  if (next === undefined) return current;
  if (current === undefined) return next;
  const rc = BINDING_STATUS_SEVERITY[current] ?? -1;
  const rn = BINDING_STATUS_SEVERITY[next] ?? -1;
  return rn > rc ? next : current;
}

/** Stable ref for receipt entries: @id when present, else @type (reference parity). */
function refOf(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  if (typeof o["@id"] === "string" && o["@id"].length > 0) return o["@id"];
  return typeof o["@type"] === "string" ? o["@type"] : "";
}

/**
 * N1 helper — true when the claim carries binding material (holderBinding / bindingProof
 * / ceremonyProof) that is PRESENT but EMPTY: an object with no own enumerable keys (or a
 * non-object placeholder), i.e. cosmetically present with nothing to verify. Returns false
 * when NO binding member is present, or when ANY present member has real content. Used
 * ONLY for the N1 honesty marker under the DEFAULT presence-based provider — a real
 * verifier judges binding content itself and is never second-guessed here.
 */
function hasOnlyEmptyBindingMaterial(claim) {
  const c = claim && typeof claim === "object" ? claim : {};
  const members = [c.holderBinding, c.bindingProof, c.ceremonyProof];
  let sawPresent = false;
  for (const member of members) {
    if (member === undefined) continue;
    sawPresent = true;
    if (member !== null && typeof member === "object" && Object.keys(member).length > 0) {
      return false; // real content present → not an empty-binding decoy
    }
  }
  return sawPresent;
}

// ===========================================================================
// (5) Bilateral negotiated floor (Base §6.4.6; CONFORMANCE §1/§4) — seam.
// ===========================================================================

/**
 * The interaction tier floor of a bilateral exchange: the MAX of both parties'
 * `requiredTrustTier`. This is a NEGOTIATED FLOOR — what the exchange demands —
 * and is DISTINCT from the effectiveTrustTier each party verifies and records
 * in its own receipt. Asymmetric requirements are valid.
 */
export function negotiateBilateralFloor(tierA, tierB) {
  return Math.max(tierOrDefault(tierA), tierOrDefault(tierB));
}

// ===========================================================================
// Demo surface (Bucket-2 invented, honest) — the crossing UI's tier panel.
// ===========================================================================

/**
 * buildTierDemoSurface — display-ready data for the crossing UI (task deliverable #5):
 *   (a) the negotiated bilateral floor of the crossing (max of both parties'
 *       requiredTrustTier, §6.4.6), labeled distinct from effectiveTrustTier;
 *   (b) a DELIBERATELY Tier-2-required sample claim run through THIS engine on the
 *       demo's Tier-1 evaluator — recording a REAL trustTierUnsupported status
 *       (never downgraded), so the UI shows the no-downgrade rule doing its job.
 *
 * Everything here is computed by the real engine — nothing is hardcoded theater.
 * The honesty block states exactly what is and is not implemented.
 */
export function buildTierDemoSurface(options = {}) {
  const localTier = tierOrDefault(options.localRequiredTrustTier);
  const remoteTier = tierOrDefault(options.remoteRequiredTrustTier);
  const max = isTrustTier(options.maxSupportedTrustTier)
    ? options.maxSupportedTrustTier
    : DEFAULT_MAX_SUPPORTED_TRUST_TIER;

  const negotiatedFloor = negotiateBilateralFloor(localTier, remoteTier);

  // The deliberately-Tier-2 sample claim (shape mirrors the conformance fixture
  // valid/claim-tier-unsupported-by-evaluator.jsonld — a crossDidBinding at Tier 2).
  const tier2SampleClaim = {
    "@id": "urn:um:claim:demo-tier2-sample",
    "@type": "identity.crossDidBinding",
    issuer: "did:web:demo.local:attester",
    boundDids: ["did:web:demo.local:user:alice", "did:pkh:eip155:1:0xdemo"],
    requiredTrustTier: 2,
    bindingProof: {
      type: "ZkLinkedSecretProof",
      cryptosuite: "bbs-2023",
      proofPurpose: "authentication",
      proofValue: "uDEMO-STRUCTURAL-ONLY",
      publicInputs: { commitmentA: "zDemoA", commitmentB: "zDemoB" },
    },
  };
  const sampleFragment = evaluateTrustTiers(
    { requiredTrustTier: 0, claims: [tier2SampleClaim] },
    { maxSupportedTrustTier: max }
  );

  return {
    negotiated_floor: negotiatedFloor,
    negotiated_floor_explain:
      `interaction tier floor = max(local ${localTier}, remote ${remoteTier}) = ${negotiatedFloor} ` +
      "(Base §6.4.6 — a NEGOTIATED floor, distinct from the effectiveTrustTier each party records)",
    parties: { local_required_trust_tier: localTier, remote_required_trust_tier: remoteTier },
    evaluator_max_supported_trust_tier: max,
    tier2_sample: {
      claim: tier2SampleClaim,
      claim_status: sampleFragment.claimStatuses[0] || null,
      verdict_contribution: sampleFragment.verdict,
      explain:
        `deliberately Tier-2-required claim on a Tier-${max} evaluator → recorded ` +
        `"trustTierUnsupported" at the capability boundary (tier ${Math.min(2, max)}), ` +
        "NEVER downgraded to a lower tier (Base §6.4.5; CONFORMANCE §2.15)",
    },
    honesty:
      "Tier floors, capability checks, Tier-0 capping and the negotiated bilateral floor are " +
      "REAL and fail closed. Tier-2 ZKP / Tier-3 ceremony VERIFICATION is NOT " +
      "implemented (runtime structural PREVIEW); holder-binding verification is runtime. " +
      "No um_conformance claim is made by this panel.",
  };
}

// ===========================================================================
// Machine-readable scope descriptor (house pattern: UM_MANIFEST_EMISSION et al).
// ===========================================================================
export const TRUST_TIER_ENGINE = Object.freeze({
  wo: "runtime",
  standard: "Universal Manifest v0.4 (Base §6.4.2/§6.4.5; EXT-T1 §T1.0/T1.1; CONFORMANCE §2.9/§2.12/§2.15/§6.1/§6.3)",
  implements: Object.freeze([
    "raise-only floor validation (claim/facet floor below manifest floor => reject; evaluator-only)",
    "capability check with NO-DOWNGRADE invariant (required tier > maxSupportedTrustTier => trustTierUnsupported at the capability boundary)",
    "manifest-level unsupported tier => rejected (+ per-facet trustTierUnsupported records)",
    "Tier-0 capping (Tier-1+ reliance without verified holder binding => tier 0, holderBindingStatus absent|failed, effectiveTrustTier 0)",
    "effectiveTrustTier receipt field (consumed by runtime)",
    "bilateral negotiated floor = max(requiredTrustTier_A, requiredTrustTier_B) (runtime seam)",
  ]),
  does_not_implement: Object.freeze([
    "holder-binding cryptographic verification (runtime — injectable holderBindingStatusOf seam; default provider is presence-based and NEVER reports verified)",
    "Tier-2 ZKP / Tier-3 ceremony verification profiles (runtime — Grade-1 structural PREVIEW; unsupported tiers fail closed here)",
    "signature/freshness verification (runtime/119), consent, projection, composed six-stage receipt (runtime/144)",
  ]),
  fail_closed: true,
  default_max_supported_trust_tier: DEFAULT_MAX_SUPPORTED_TRUST_TIER,
  um_conformance_claimed: false,
  scope_boundary:
    "Trust-tier ENFORCEMENT logic only — a receipt FRAGMENT provider for the composing v0.4 " +
    "evaluator. Flips no um_conformance flag; tier honesty for the demo's entity-type/age " +
    "attestations rides on this engine.",
});
