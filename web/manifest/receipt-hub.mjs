// BEGIN — v0.4 structured um:Receipt hub + single-manifest receipt chain.
//
// ============================================================================
// THIS MODULE IS THE SINGLE OWNER OF THE CANONICAL um:Receipt SHAPE.
// ============================================================================
// Six later tasks write into the fields defined here
// and verifies receipts against conformance/v0.4/expected.json with the
// comparator exported here. DO NOT fork this shape — extend it HERE.
//
// External source of truth (READ-ONLY):
//   spec/v0.4/CONFORMANCE.md   §2.5 (six required receipt members), §2.6 (the
//                              8-value facet status set), §4 (bilateral receipts
//                              MUST carry exchangeId + evaluatorId)
//   spec/v0.4/schema.jsonld    receipt context terms (manifestId, outcome,
//                              signatureCheck, freshnessCheck, facetStatuses,
//                              consentStatuses, claimStatuses, unprocessedEntries,
//                              holderBindingStatus, presentationProofStatus,
//                              livenessStatus, crossDidBindingStatus,
//                              effectiveTrustTier, keyRefResolution, warnings,
//                              code, message, receiptId, evaluatorId, exchangeId,
//                              events, eventType, at, subjectRef, facetKeyRef,
//                              seq, prevHash, chainId, receiptSignature)
//   conformance/v0.4/expected.json                 the 25 evaluation-mode entries
//   conformance/v0.4/valid/receipt-facet-key-shredded.jsonld
//                              the ON-WIRE receipt-as-manifest exemplar:
//                              @type ["um:Manifest","um:Receipt"] + events[]
//                              {eventType, at, facetKeyRef, reason} (EXT-OPT
//                              receipts-as-a-class, PREVIEW)
//   examples/integrations/rp1-spatial-fabric/service-encounter/private-data-status/
//     factory-floor-policy-vector/expected-receipt-trace.json
//                              the fixture-local 3-path trace oracle: events
//                              {seq, eventClass, subject, reason, capability?,
//                              target?, facetKeyRef?}; minimizedReceiptObligations
//                              requiredFields [seq,eventClass,subject,reason],
//                              forbiddenPayloads, flushPolicy "session-end"
//
// ============================================================================
// THE CANONICAL RECEIPT CONTAINER (what every consumer binds to)
// ============================================================================
//
//   {
//     "@type": "um:Receipt",              // string form for stage receipts;
//                                         // promoteReceiptToManifest() emits the
//                                         // on-wire ["um:Manifest","um:Receipt"]
//     receiptId?:  "urn:uuid:…",          // um:receiptId (optional, minted on demand)
//     manifestId:  "<@id of the evaluated manifest>",     // REQUIRED  (MUST §2.5)
//     outcome:     "accepted" | "accepted-with-warnings"  // REQUIRED  (MUST §2.5)
//                | "accepted-partial" | "rejected",
//     signatureCheck: "valid" | "invalid" | "unsupported-profile"
//                   | "missing" | "not-evaluated",        // REQUIRED  (MUST §2.5)
//     freshnessCheck: "fresh" | "expired" | "stale"
//                   | "not-evaluated",                    // REQUIRED  (MUST §2.5)
//     facetStatuses: [ { facetId, name?, status, reason?, consentRef?,
//                        assuranceStatus?: { assertedClass, met } } ],
//                                         // REQUIRED (MUST §2.5; [] when the
//                                         // manifest carries zero facets).
//                                         // status ∈ the 8-value set (MUST §2.6).
//     warnings: [ { code, message } ],    // REQUIRED member (may be []). code is
//                                         // a um:reason:* token (see WARNING_CODES);
//                                         // message is free diagnostic text.
//     — extended disposition fields (present ONLY when defined; mirrors the
//       reference evaluator, which omits undefined members entirely) —
//     keyRefResolution?:        "resolved" | "unresolved",
//     revocationStatus?:        "unchecked" | "active" | "revoked" | "suspended",
//     consentStatuses?:   [ { consentRef, facetRef, status, reason? } ],
//                         // status ∈ granted|expired|withdrawn|scope-mismatch|
//                         //          condition-violated
//     claimStatuses?:     [ { claimRef, status, tier?, reason? } ],
//                         // status ∈ bound|unverified|unprocessable|
//                         //          trustTierUnsupported
//     unprocessedEntries?:[ { kind, type, ref? } ], // writes
//     holderBindingStatus?:     "verified"|"failed"|"unsupported-mode"|"absent",
//     presentationProofStatus?: "verified"|"failed"|"missing-required"|"absent",
//     livenessStatus?:    { freshnessClass: "live"|"recent"|"stale"|"unknown",
//                           attestedAt?, validUntil?, userVerified? }, //
//     crossDidBindingStatus?: string, // writes
//     effectiveTrustTier?: 0|1|2|3, // write
//     — bilateral correlation (Base §4; REQUIRED inside a bilateral session) —
//     exchangeId?:  "urn:um:exchange:<hex128>",  // ≥128-bit entropy, encodes NO
//     evaluatorId?: "<evaluator DID>",           // party identifiers (README §sec)
//     — receipt events (on-wire, schema.jsonld terms; PREVIEW receipts-as-a-class) —
//     events?: [ { eventType, at, subjectRef?, facetKeyRef?, reason? } ],
//     processedAt?: ISO-8601,                    // omitted under omitProcessedAt
//     PREVIEW hash-chain surface, RESERVED FOR (EXT-OPT §O4). This hub
//       DEFINES the fields and validates writes via reserveChainLinkFields() but
//       NEVER computes a hash chain (single-chain discipline, matrix G6) —
//     seq?: integer, prevHash?: "sha256:<hex>"|null, chainId?: string,
//     receiptSignature?: {…}                     // or promote + Profile A sign
//   }
//
// ============================================================================
// HOW THE EXISTING FRAGMENTS MAP INTO THIS CONTAINER (mergeFragment)
// ============================================================================
// evaluateTrustTiers fragment:
//     verdict → outcome contribution ("rejected" is sticky) · claimStatuses/
//     facetStatuses/warnings → merged (tier paths take precedence: an entry this
//     fragment wrote is never re-statused) · holderBindingStatus/effectiveTrustTier
//     → rolled · engine/rejectedBy/floorViolations/deferredClaims/deferredFacetIds
//     → diagnostics (NOT wire members).
// evaluateHolderBinding receipt:
//     already receipt-shaped — outcome/signatureCheck/freshnessCheck/
//     keyRefResolution/presentationProofStatus/holderBindingStatus/
//     effectiveTrustTier/claimStatuses/warnings merge directly.
// evaluateConsentGating receipt / evaluateConsentStage fragment:
//     facetStatuses (processed|consent-missing|consent-denied) + consentStatuses
//     {consentRef, facetRef, status, reason} + warnings merge directly;
//     processed/notProcessed → diagnostics.
// projectStageReceipt fragment:
//     facetStatuses (incl. "not-projected") / claimStatuses / unprocessedEntries /
//     holderBindingStatus / effectiveTrustTier merge directly; verdict → outcome
//     contribution.
// evaluateDelegationRegistry receipt:
//     outcome/signatureCheck/warnings merge directly (its warnings[]{code,message}
//     shape anticipated this hub and is adopted UNCHANGED as the canonical
//     warning shape); delegations[] → diagnostics (not a schema.jsonld term).
// featureFixtureHandler receipt:
//     facetStatuses ("opaque" sealed entries) + warnings merge directly.
//
//   RECOMMENDED MERGE ORDER ("processed" and "unverified" are weakest-baseline
//   statuses and are always overridable):
//     tier (133) → assurance (135) → sealed (132) → consent (122) → projection (123)
//   Merge order sets precedence ONLY for set-if-absent members and equal-
//   severity status ties. Same-key facet/claim STATUS conflicts resolve
//   SEVERITY-RANKED (most-severe-wins — FACET_STATUS_DOMINANCE /
//   CLAIM_STATUS_DOMINANCE below), so a reject/deny/tier-cap can NOT be lost
//   to merge order (hardening F1/F2/F3).
//
// ============================================================================
// SEAMS AND CONVENTIONS
// ============================================================================
// SEAM (bilateral session + receipt hash-chaining — NOT built here):
//     stampBilateral writes exchangeId/evaluatorId (supplies values
//       from its session object; mintExchangeId() is provided for the demo).
//     reserveChainLinkFields writes seq/prevHash/chainId — is the ONLY
//       computer of prevHash. HASH CONVENTION (empirically pinned):
//       chain hashes use canonicalManifestHash() from projection.mjs —
//       deep-key-sorted JSON over the WHOLE document INCLUDING `signature`.
//       This is DISTINCT from the JCS *signing-input* exclusion set
//       {signature, postQuantumSignature, presentationProof} used.
//       Do not conflate the two.
//     · sealReceiptChain() marks the chain sealed (flushPolicy "session-end");
//       the hash-chain seal + paired-receipt correlation live.
// SEAM: PREVIEW key-lifecycle events "facet-key-rotated"/
//     "facet-key-shredded" are appended via appendChainEvent/
//     receipt events — they are defined in PREVIEW_KEY_LIFECYCLE_EVENTS here.
// SEAM: SOM/inter-service decisions surface as chain events with the
//     16-class labels (capability-granted/denied etc.) via appendChainEvent().
// SEAM: assertReceiptAgainstExpectedEntry is the receipt comparator
//     for every evaluation-mode expected.json entry.
// SEAM: buildReceiptExpectationsFacet (P16) attaches through the
//     emitter's facet array; buildReceiptChainFacet() (P17) carries a chain.
//
// HONESTY CEILING: real receipt structure + outcome logic only. The RP1
// "16-class receipt taxonomy" is page/fixture NARRATIVE over the single
// normative class um:Receipt — an extensible eventType label surface, NOT a
// normative class hierarchy. Receipts-as-manifests,
// hash-chaining (seq/prevHash) and bilateral correlation are EXT-OPT PREVIEW —
// labeled as such, never claimed as Base conformance. NO um_conformance flag is
// flipped by this module. Grade-2 design-stage members are not emitted.
//
// Browser-safe (WebCrypto only); Node >= 18 for the verifier driver.

import { UM_V04_CONTEXT, UM_V04_MANIFEST_VERSION } from "./interfaces.mjs";
import { attachSignatureProfileA } from "../signing/um-signature-profile-a.mjs";

// ===========================================================================
// 1) VALUE SETS — the canonical enums (CONFORMANCE §2.5/§2.6, EXT-T1, EXT-OPT)
// ===========================================================================

/** The 4-value Compose outcome set (Base §3.1.5 / six-stage summary #5). */
export const RECEIPT_OUTCOMES = Object.freeze([
  "accepted",
  "accepted-with-warnings",
  "accepted-partial",
  "rejected",
]);

/** The 8-value per-facet status set (CONFORMANCE §2.6; MUST-6). */
export const FACET_STATUS_SET = Object.freeze([
  "processed",
  "opaque",
  "consent-denied",
  "consent-missing",
  "trustTierUnsupported",
  "assuranceInsufficient", // PREVIEW (assurance floors, EXT-T1 T1.3.3)
  "not-projected",
  "written", // PREVIEW (write authorization, Base 3.1.4)
]);

/** signatureCheck values ("missing" is the house extension for a absent
 *  signature member; the canonical rejection posture is "not-evaluated" + a
 *  um:reason:crypto:signature-missing warning — both validate). */
export const SIGNATURE_CHECKS = Object.freeze([
  "valid",
  "invalid",
  "unsupported-profile",
  "missing",
  "not-evaluated",
]);

export const FRESHNESS_CHECKS = Object.freeze(["fresh", "expired", "stale", "not-evaluated"]);

export const HOLDER_BINDING_STATUSES = Object.freeze(["verified", "failed", "unsupported-mode", "absent"]);
export const PRESENTATION_PROOF_STATUSES = Object.freeze(["verified", "failed", "missing-required", "absent"]);
export const LIVENESS_FRESHNESS_CLASSES = Object.freeze(["live", "recent", "stale", "unknown"]);
export const KEYREF_RESOLUTIONS = Object.freeze(["resolved", "unresolved"]);
/** statusRef resolution statuses (Base §3.4) + the not-implementing posture. */
export const REVOCATION_STATUSES = Object.freeze(["unchecked", "active", "revoked", "suspended"]);
export const CONSENT_ENTRY_STATUSES = Object.freeze(["granted", "expired", "withdrawn", "scope-mismatch", "condition-violated"]);
export const CLAIM_ENTRY_STATUSES = Object.freeze(["bound", "unverified", "unprocessable", "trustTierUnsupported"]);

/** The six-stage evaluation sequence (Base §3.1) — receipt events MAY carry a
 *  stage label in `reason` narrative; the sequence itself is fixed. */
export const SIX_STAGES = Object.freeze(["Arrive", "Verify", "Project", "Consent", "Compose", "Receipt"]);

/**
 * The RP1 16-class receipt-event taxonomy (rp1-spatial-fabric page,
 * R5). NARRATIVE LABELING LAYER over um:Receipt outcomes — an extensible
 * `eventType` string surface, NOT a normative class hierarchy. Mapping to
 * receipt outcomes: session-admitted ↔ outcome accepted at
 * Arrive/Verify; capability-denied ↔ facet consent-denied; package-rejected ↔
 * content-trust failure; cross-fabric-portal-cleared ↔ successful
 * attachment traversal; avatar-retrieved/substituted ↔ Compose outcomes;
 * shader-trusted/rejected ↔ SPIR-V/asset trust checks.
 */
export const RP1_EVENT_TAXONOMY = Object.freeze([
  "session-admitted",
  "session-denied",
  "session-degraded",
  "capability-granted",
  "capability-denied",
  "capability-revoked",
  "package-trusted",
  "package-rejected",
  "policy-override-applied",
  "cross-fabric-portal-cleared",
  "terms-acknowledged",
  "co-presence-entity-type-asserted",
  "avatar-retrieved",
  "avatar-substituted",
  "shader-trusted",
  "shader-rejected",
]);

/** PREVIEW key-lifecycle receipt events (v0.4 Base §7.2 / EXT-OPT O3; fixture
 *  valid/receipt-facet-key-shredded.jsonld). Appended. */
export const PREVIEW_KEY_LIFECYCLE_EVENTS = Object.freeze(["facet-key-rotated", "facet-key-shredded"]);

/** Fixture-local event classes the factory-floor trace uses beyond the 16
 *  (fixture oracle, not a source-namespace claim). */
export const FIXTURE_LOCAL_EVENT_CLASSES = Object.freeze(["session-unlocked", "departure"]);

export function isCanonicalEventClass(eventClass) {
  return (
    RP1_EVENT_TAXONOMY.includes(eventClass) ||
    PREVIEW_KEY_LIFECYCLE_EVENTS.includes(eventClass) ||
    FIXTURE_LOCAL_EVENT_CLASSES.includes(eventClass)
  );
}

/**
 * Registry of um:reason:* warning codes already emitted by the fragment engines
 * (the canonical warning shape is { code, message } — adopted,
 * asserted by expected.json expectedWarningsContain). New writers add codes
 * HERE so comparator and the demo panel share one vocabulary.
 */
export const WARNING_CODES = Object.freeze([
  // structure / crypto / freshness
  "um:reason:structure:malformed",
  "um:reason:crypto:signature-missing",
  "um:reason:crypto:signature-invalid",
  "um:reason:crypto:unsupported-profile",
  "um:reason:freshness:stale",
  "um:reason:freshness:expired",
  // trust tier / binding — expected.json asserts unbound-claims
  "um:reason:trust:tier-unsupported",
  "um:reason:trust:unbound-claims",
  "um:reason:trust:binding-failed",
  "um:reason:trust:binding-mode-unsupported",
  "um:reason:trust:presentation-validation-failed",
  "um:reason:trust:presentation-validation-missing",
  // consent lifecycle
  "um:reason:consent:consent-missing",
  "um:reason:consent:expired",
  "um:reason:consent:withdrawn",
  "um:reason:consent:scope-mismatch",
  "um:reason:consent:condition-violated",
  // agent delegation — expected.json asserts the first three
  "um:reason:delegation:expired",
  "um:reason:delegation:empty-scope",
  "um:reason:delegation:unattributed",
  "um:reason:delegation:unregistered-scope",
  "um:reason:delegation:delegator-mismatch",
  // PREVIEW key lifecycle
  "um:reason:crypto:key-rotated",
  "um:reason:crypto:key-shredded",
]);

/** minimizedReceiptObligations (factory-floor oracle): every chain event MUST
 *  carry these fields and MUST NOT carry the forbidden payload classes. */
export const CHAIN_EVENT_REQUIRED_FIELDS = Object.freeze(["seq", "eventClass", "subject", "reason"]);
export const CHAIN_EVENT_OPTIONAL_FIELDS = Object.freeze(["capability", "target", "facetKeyRef", "at"]);
export const CHAIN_FORBIDDEN_PAYLOADS = Object.freeze([
  "raw-um-manifests",
  "raw-embedded-credentials",
  "decrypted-private-facet-contents",
  "key-material",
  "zkp-material",
  "source-adapter-payloads",
]);

// ===========================================================================
// 2) SMALL HELPERS
// ===========================================================================

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isIsoDateTime(v) {
  return isNonEmptyString(v) && Number.isFinite(Date.parse(v));
}
function isTierInt(v) {
  return Number.isInteger(v) && v >= 0 && v <= 3;
}
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let hex = "";
  for (const b of buf) hex += b.toString(16).padStart(2, "0");
  return hex;
}
function mintUrnUuid() {
  return `urn:uuid:${globalThis.crypto.randomUUID()}`;
}

// ===========================================================================
// 3) CONTAINER LIFECYCLE — create / validate / merge / compose / finalize
// ===========================================================================

/**
 * Create an in-progress canonical receipt for one evaluated manifest. The four
 * check members start "not-evaluated"/[] so stage engines write REAL results;
 * outcome starts "rejected" (fail closed — finalizeReceipt() composes the true
 * outcome; an abandoned receipt never reads as accepted).
 */
export function createReceipt({ manifestId, evaluatorId, exchangeId, receiptId } = {}) {
  const receipt = {
    "@type": "um:Receipt",
    manifestId: isNonEmptyString(manifestId) ? manifestId : "(unknown)",
    outcome: "rejected",
    signatureCheck: "not-evaluated",
    freshnessCheck: "not-evaluated",
    facetStatuses: [],
    warnings: [],
  };
  if (isNonEmptyString(receiptId)) receipt.receiptId = receiptId;
  if (isNonEmptyString(evaluatorId)) receipt.evaluatorId = evaluatorId;
  if (isNonEmptyString(exchangeId)) receipt.exchangeId = exchangeId;
  return receipt;
}

/**
 * THE CONTRACT CHECK every consumer runs before trusting/emitting a receipt.
 * Validates the six required members (MUST §2.5), the 8-value facet status set
 * (MUST §2.6), the {code,message} warning shape, and every extended-disposition
 * field that is PRESENT (absent optional members are fine — the reference
 * omits undefined members entirely). Returns { valid, errors }.
 */
export function validateReceiptShape(receipt) {
  const errors = [];
  const r = receipt;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { valid: false, errors: ["receipt must be an object"] };

  const t = r["@type"];
  const hasReceiptType = t === "um:Receipt" || (Array.isArray(t) && t.includes("um:Receipt"));
  if (!hasReceiptType) errors.push('@type must be or include "um:Receipt" (MUST 2.5)');
  if (!isNonEmptyString(r.manifestId)) errors.push("manifestId is required (MUST 2.5)");
  if (!RECEIPT_OUTCOMES.includes(r.outcome)) errors.push(`outcome must be one of ${RECEIPT_OUTCOMES.join("|")} (MUST 2.5)`);
  if (!SIGNATURE_CHECKS.includes(r.signatureCheck)) errors.push(`signatureCheck must be one of ${SIGNATURE_CHECKS.join("|")}`);
  if (!FRESHNESS_CHECKS.includes(r.freshnessCheck)) errors.push(`freshnessCheck must be one of ${FRESHNESS_CHECKS.join("|")}`);

  if (!Array.isArray(r.facetStatuses)) {
    errors.push("facetStatuses must be an array (empty when the manifest has zero facets — MUST 2.5)");
  } else {
    r.facetStatuses.forEach((f, i) => {
      if (!f || typeof f !== "object") return errors.push(`facetStatuses[${i}] must be an object`);
      if (!isNonEmptyString(f.facetId) && !isNonEmptyString(f.name)) errors.push(`facetStatuses[${i}] needs facetId (or name)`);
      if (!FACET_STATUS_SET.includes(f.status)) errors.push(`facetStatuses[${i}].status "${f.status}" not in the 8-value set (MUST 2.6)`);
      if (f.assuranceStatus !== undefined) {
        const a = f.assuranceStatus;
        if (!a || typeof a !== "object" || !isNonEmptyString(a.assertedClass) || typeof a.met !== "boolean") {
          errors.push(`facetStatuses[${i}].assuranceStatus must be { assertedClass: string, met: boolean }`);
        }
      }
    });
  }

  // warnings is the hub's guaranteed write surface (createReceipt always
  // initializes it) but is NOT one of the six spec-REQUIRED members (MUST 2.5),
  // so a spec-conformant foreign receipt without it still validates.
  if (r.warnings !== undefined) {
    if (!Array.isArray(r.warnings)) {
      errors.push("warnings must be an array of { code, message } when present");
    } else {
      r.warnings.forEach((w, i) => {
        if (!w || typeof w !== "object" || !isNonEmptyString(w.code) || !isNonEmptyString(w.message)) {
          errors.push(`warnings[${i}] must be { code: string, message: string }`);
        }
      });
    }
  }

  // Extended disposition fields — validated only when PRESENT.
  if (r.keyRefResolution !== undefined && !KEYREF_RESOLUTIONS.includes(r.keyRefResolution)) errors.push(`keyRefResolution "${r.keyRefResolution}" invalid`);
  if (r.revocationStatus !== undefined && !REVOCATION_STATUSES.includes(r.revocationStatus)) errors.push(`revocationStatus "${r.revocationStatus}" invalid`);
  if (r.holderBindingStatus !== undefined && !HOLDER_BINDING_STATUSES.includes(r.holderBindingStatus)) errors.push(`holderBindingStatus "${r.holderBindingStatus}" invalid`);
  if (r.presentationProofStatus !== undefined && !PRESENTATION_PROOF_STATUSES.includes(r.presentationProofStatus)) errors.push(`presentationProofStatus "${r.presentationProofStatus}" invalid`);
  if (r.effectiveTrustTier !== undefined && !isTierInt(r.effectiveTrustTier)) errors.push("effectiveTrustTier must be an integer 0..3");
  if (r.crossDidBindingStatus !== undefined && !isNonEmptyString(r.crossDidBindingStatus)) errors.push("crossDidBindingStatus must be a non-empty string");
  if (r.livenessStatus !== undefined) {
    const l = r.livenessStatus;
    if (!l || typeof l !== "object" || !LIVENESS_FRESHNESS_CLASSES.includes(l.freshnessClass)) {
      errors.push(`livenessStatus must be an object with freshnessClass ∈ ${LIVENESS_FRESHNESS_CLASSES.join("|")}`);
    }
  }
  if (r.consentStatuses !== undefined) {
    if (!Array.isArray(r.consentStatuses)) errors.push("consentStatuses must be an array");
    else r.consentStatuses.forEach((c, i) => {
      if (!c || !isNonEmptyString(c.consentRef) || !isNonEmptyString(c.status)) errors.push(`consentStatuses[${i}] must carry consentRef + status`);
      else if (!CONSENT_ENTRY_STATUSES.includes(c.status)) errors.push(`consentStatuses[${i}].status "${c.status}" invalid`);
    });
  }
  if (r.claimStatuses !== undefined) {
    if (!Array.isArray(r.claimStatuses)) errors.push("claimStatuses must be an array");
    else r.claimStatuses.forEach((c, i) => {
      if (!c || !isNonEmptyString(c.claimRef) || !isNonEmptyString(c.status)) errors.push(`claimStatuses[${i}] must carry claimRef + status`);
      if (c && c.tier !== undefined && !isTierInt(c.tier)) errors.push(`claimStatuses[${i}].tier must be an integer 0..3`);
    });
  }
  if (r.unprocessedEntries !== undefined) {
    if (!Array.isArray(r.unprocessedEntries)) errors.push("unprocessedEntries must be an array");
    else r.unprocessedEntries.forEach((u, i) => {
      if (!u || !isNonEmptyString(u.kind)) errors.push(`unprocessedEntries[${i}] must carry kind (+ type)`);
    });
  }
  if (r.events !== undefined) {
    if (!Array.isArray(r.events)) errors.push("events must be an array");
    else r.events.forEach((e, i) => {
      if (!e || !isNonEmptyString(e.eventType)) errors.push(`events[${i}] must carry eventType`);
      if (e && e.at !== undefined && !isIsoDateTime(e.at)) errors.push(`events[${i}].at must be ISO 8601`);
    });
  }
  if (r.exchangeId !== undefined && !isNonEmptyString(r.exchangeId)) errors.push("exchangeId must be a non-empty string");
  if (r.evaluatorId !== undefined && !isNonEmptyString(r.evaluatorId)) errors.push("evaluatorId must be a non-empty string");
  if (r.seq !== undefined && !(Number.isInteger(r.seq) && r.seq >= 0)) errors.push("seq must be a non-negative integer (EXT-OPT O4 PREVIEW)");
  if (r.prevHash !== undefined && r.prevHash !== null && !/^sha256:[0-9a-f]{64}$/.test(String(r.prevHash))) {
    errors.push('prevHash must be "sha256:<64 hex>" or null (genesis) — computed ONLY by runtime');
  }
  if (r.processedAt !== undefined && !isIsoDateTime(r.processedAt)) errors.push("processedAt must be ISO 8601");

  return { valid: errors.length === 0, errors };
}

/** Weakest-baseline statuses: overridable by any more specific status. */
const FACET_BASELINE = "processed"; // Project-stage baseline
const CLAIM_BASELINE = "unverified";
const HB_DOMINANCE = { failed: 3, "unsupported-mode": 2, absent: 1, verified: 0 };
const PP_DOMINANCE = { failed: 3, "missing-required": 2, verified: 1, absent: 0 };

/**
 * Outcome-severity dominance for SAME-KEY facet-status conflicts — mirrors
 * HB_DOMINANCE/PP_DOMINANCE so the composition is merge-order-proof (hardening
 * F1/F2): the MORE-SEVERE status wins regardless of arrival order. Previously
 * conflicts were keep-first, so a reject-worthy status merged AFTER a weaker
 * same-facetId status was dropped (recorded only as an unread diagnostic) and
 * the finalized outcome escalated to a more-accepting one. Ranks follow
 * composeOutcome's mapping: assuranceInsufficient can force "rejected" (rule 1)
 * > the accepted-partial "failed" statuses (rule 2) > the sealed statuses
 * (rule 3) > the neutral "not-projected" > the processed-evidence "written"
 * (rule-1 escape) > the overridable "processed" baseline. EQUAL-severity
 * disagreement keeps the first writer + a conflict diagnostic (unchanged);
 * a status OUTSIDE the table never displaces and is never displaced except by
 * the baseline-override rule (a junk status still fails closed at finalize).
 */
const FACET_STATUS_DOMINANCE = Object.freeze({
  assuranceInsufficient: 5,
  "consent-denied": 4,
  trustTierUnsupported: 4,
  opaque: 3,
  "consent-missing": 3,
  "not-projected": 2,
  written: 1,
  processed: 0,
});

/** Same severity rule for claimStatuses (hardening F3): a trustTierUnsupported
 *  tier cap (accepted-partial, composeOutcome rule 4) must never be masked by a
 *  weaker status ("bound") arriving on the same claimRef in either order. */
const CLAIM_STATUS_DOMINANCE = Object.freeze({
  trustTierUnsupported: 3,
  unprocessable: 2,
  bound: 1,
  unverified: 0,
});

/**
 * Fold ONE engine fragment into the canonical receipt. Accepts every fragment
 * shape in the tree today (see the header mapping
 * table) as PLAIN DATA; this hub imports none of the engines. Returns a
 * diagnostics record { rejected, conflicts, engine?, extras } the caller
 * accumulates; nothing non-normative is ever written onto the wire shape.
 *
 * Merge rules (stable — consumers rely on these):
 *   facetStatuses      keyed by facetId (falling back to name). The "processed"
 *                      baseline is overridden by any specific status; conflicting
 *                      specific statuses resolve SEVERITY-RANKED via
 *                      FACET_STATUS_DOMINANCE (most-severe-wins, merge-order-
 *                      proof — hardening F1/F2), recording a conflict
 *                      diagnostic; EQUAL-severity disagreement keeps the first
 *                      writer and records a conflict diagnostic.
 *   claimStatuses      keyed by claimRef: same rule with baseline "unverified"
 *                      and CLAIM_STATUS_DOMINANCE (a trustTierUnsupported cap
 *                      is never masked — hardening F3). Tier paths
 *                      still merge first by convention so their non-status
 *                      fields take first-writer precedence.
 *   consentStatuses    deduped by consentRef+facetRef (first wins).
 *   unprocessedEntries deduped by kind+type+ref.
 *   warnings           appended; exact {code,message} duplicates dropped.
 *   holderBindingStatus     failure-dominant (failed > unsupported-mode >
 *                           absent > verified) — roll-up rule.
 *   presentationProofStatus failure-dominant (failed > missing-required >
 *                           verified > absent).
 *   effectiveTrustTier      0-sticky (a Tier-0 cap never un-caps), else max.
 *   signatureCheck/freshnessCheck  set when receipt still "not-evaluated";
 *                           disagreement afterwards → conflict diagnostic.
 *   keyRefResolution / revocationStatus / livenessStatus /
 *   crossDidBindingStatus / exchangeId / evaluatorId   set-if-absent.
 *   outcome/verdict         contribution only: "rejected" is sticky via the
 *                           returned diagnostics (finalizeReceipt applies it).
 */
export function mergeFragment(receipt, fragment) {
  const diag = { rejected: false, conflicts: [], extras: {} };
  if (!fragment || typeof fragment !== "object") return diag;
  const f = fragment;
  if (isNonEmptyString(f.engine)) diag.engine = f.engine;

  // --- outcome contribution --------------------------------------------------
  const contribution = isNonEmptyString(f.outcome) ? f.outcome : f.verdict;
  if (contribution === "rejected") diag.rejected = true;

  // --- signature / freshness ---------------------------------------------------
  for (const key of ["signatureCheck", "freshnessCheck"]) {
    if (!isNonEmptyString(f[key])) continue;
    if (receipt[key] === "not-evaluated" || receipt[key] === undefined) receipt[key] = f[key];
    else if (receipt[key] !== f[key]) diag.conflicts.push(`${key}: kept "${receipt[key]}", fragment said "${f[key]}"`);
  }

  // --- facetStatuses -----------------------------------------------------------
  if (Array.isArray(f.facetStatuses)) {
    for (const entry of f.facetStatuses) {
      if (!entry || typeof entry !== "object") continue;
      const key = entry.facetId ?? entry.name;
      const existing = receipt.facetStatuses.find((x) => (x.facetId ?? x.name) === key);
      if (!existing) {
        receipt.facetStatuses.push({ ...entry });
      } else if (existing.status === FACET_BASELINE && entry.status !== FACET_BASELINE) {
        Object.assign(existing, entry); // specific status overrides the baseline
      } else if (
        entry.status !== existing.status &&
        (FACET_STATUS_DOMINANCE[entry.status] ?? -1) > (FACET_STATUS_DOMINANCE[existing.status] ?? Infinity)
      ) {
        // Severity-ranked resolution (hardening F1/F2): the MORE-SEVERE status
        // wins regardless of merge order — a reject-worthy assuranceInsufficient
        // must never be dropped because a weaker same-facetId status (e.g.
        // consent-denied or written) arrived first.
        diag.conflicts.push(`facet ${key}: "${existing.status}" superseded by more-severe "${entry.status}"`);
        Object.assign(existing, entry);
      } else if (entry.status !== existing.status && entry.status !== FACET_BASELINE) {
        diag.conflicts.push(`facet ${key}: kept "${existing.status}", fragment said "${entry.status}"`);
      }
    }
  }

  // --- claimStatuses -----------------------------------------------------------
  if (Array.isArray(f.claimStatuses)) {
    if (receipt.claimStatuses === undefined) receipt.claimStatuses = [];
    for (const entry of f.claimStatuses) {
      if (!entry || typeof entry !== "object") continue;
      const existing = receipt.claimStatuses.find((x) => x.claimRef === entry.claimRef);
      if (!existing) {
        receipt.claimStatuses.push({ ...entry });
      } else if (existing.status === CLAIM_BASELINE && entry.status !== CLAIM_BASELINE) {
        Object.assign(existing, entry);
      } else if (
        entry.status !== existing.status &&
        (CLAIM_STATUS_DOMINANCE[entry.status] ?? -1) > (CLAIM_STATUS_DOMINANCE[existing.status] ?? Infinity)
      ) {
        // Severity-ranked resolution (hardening F3): a trustTierUnsupported tier
        // cap wins over an earlier "bound" on the same claimRef in either merge
        // order — the entry carries its capped tier with it, so the surviving
        // claim status agrees with the (already 0-sticky) effectiveTrustTier.
        diag.conflicts.push(`claim ${entry.claimRef}: "${existing.status}" superseded by more-severe "${entry.status}"`);
        Object.assign(existing, entry);
      } else if (entry.status !== existing.status && entry.status !== CLAIM_BASELINE) {
        diag.conflicts.push(`claim ${entry.claimRef}: kept "${existing.status}", fragment said "${entry.status}"`);
      }
    }
    if (receipt.claimStatuses.length === 0) delete receipt.claimStatuses;
  }

  // --- consentStatuses / unprocessedEntries -------------------------------------
  if (Array.isArray(f.consentStatuses) && f.consentStatuses.length > 0) {
    if (receipt.consentStatuses === undefined) receipt.consentStatuses = [];
    for (const entry of f.consentStatuses) {
      if (!entry) continue;
      const dup = receipt.consentStatuses.some((x) => x.consentRef === entry.consentRef && x.facetRef === entry.facetRef);
      if (!dup) receipt.consentStatuses.push({ ...entry });
    }
  }
  if (Array.isArray(f.unprocessedEntries) && f.unprocessedEntries.length > 0) {
    if (receipt.unprocessedEntries === undefined) receipt.unprocessedEntries = [];
    for (const entry of f.unprocessedEntries) {
      if (!entry) continue;
      const dup = receipt.unprocessedEntries.some((x) => x.kind === entry.kind && x.type === entry.type && x.ref === entry.ref);
      if (!dup) receipt.unprocessedEntries.push({ ...entry });
    }
  }

  // --- warnings ------------------------------------------------------------------
  if (Array.isArray(f.warnings)) {
    if (!Array.isArray(receipt.warnings)) receipt.warnings = [];
    for (const w of f.warnings) {
      if (!w || !isNonEmptyString(w.code) || !isNonEmptyString(w.message)) continue;
      const dup = receipt.warnings.some((x) => x.code === w.code && x.message === w.message);
      if (!dup) receipt.warnings.push({ code: w.code, message: w.message });
    }
  }

  // --- roll-ups --------------------------------------------------------------------
  if (isNonEmptyString(f.holderBindingStatus)) {
    const cur = receipt.holderBindingStatus;
    if (cur === undefined || (HB_DOMINANCE[f.holderBindingStatus] ?? -1) > (HB_DOMINANCE[cur] ?? -1)) {
      receipt.holderBindingStatus = f.holderBindingStatus;
    }
  }
  if (isNonEmptyString(f.presentationProofStatus)) {
    const cur = receipt.presentationProofStatus;
    if (cur === undefined || (PP_DOMINANCE[f.presentationProofStatus] ?? -1) > (PP_DOMINANCE[cur] ?? -1)) {
      receipt.presentationProofStatus = f.presentationProofStatus;
    }
  }
  if (Number.isInteger(f.effectiveTrustTier)) {
    if (receipt.effectiveTrustTier === 0 || f.effectiveTrustTier === 0) receipt.effectiveTrustTier = 0; // cap is sticky
    else receipt.effectiveTrustTier = Math.max(receipt.effectiveTrustTier ?? 0, f.effectiveTrustTier);
  }
  for (const key of ["keyRefResolution", "revocationStatus", "crossDidBindingStatus", "exchangeId", "evaluatorId"]) {
    if (receipt[key] === undefined && isNonEmptyString(f[key])) receipt[key] = f[key];
  }
  if (receipt.livenessStatus === undefined && f.livenessStatus && typeof f.livenessStatus === "object") {
    receipt.livenessStatus = { ...f.livenessStatus };
  }

  // --- receipt events (on-wire shape) --------------------------------------------
  if (Array.isArray(f.events) && f.events.length > 0) {
    if (receipt.events === undefined) receipt.events = [];
    for (const e of f.events) if (e && isNonEmptyString(e.eventType)) receipt.events.push({ ...e });
  }

  // --- engine diagnostics: known non-wire members are captured, never emitted ----
  for (const key of ["delegations", "floorViolations", "deferredClaims", "deferredFacetIds", "rejectedBy", "processed", "notProcessed", "manifestTier", "maxSupportedTrustTier"]) {
    if (f[key] !== undefined) diag.extras[key] = f[key];
  }
  return diag;
}

/**
 * The canonical Compose-stage outcome mapping (reference evaluator mapping as
 * reproduced fixture-exactly, + the warnings rule):
 *   1. assuranceInsufficient present and NOTHING processed        → rejected
 *   2. any facet consent-denied | trustTierUnsupported |
 *      assuranceInsufficient                                       → accepted-partial
 *   3. any sealed facet (opaque | consent-missing)                 → accepted-partial
 *   4. any claim trustTierUnsupported                              → accepted-partial
 *   5. any warnings                                                → accepted-with-warnings
 *   6. otherwise                                                   → accepted
 * NOTES pinned by expected.json: "unprocessable" claims and unprocessedEntries
 * do NOT degrade the outcome (fixtures claim-unrecognized-type and
 * pointer-unrecognized-type are outcome "accepted"); recorded postures
 * (keyRefResolution "unresolved", livenessStatus.freshnessClass "unknown") are
 * NOT warnings. "not-projected" is neutral (absence is not evidence of absence).
 * v0.3-backcompat path pins "accepted-with-warnings" over "partial" —
 * pass finalizeReceipt({ outcomeOverride }) for such fixture-pinned routes.
 */
export function composeOutcome(receipt) {
  const facets = Array.isArray(receipt.facetStatuses) ? receipt.facetStatuses : [];
  const claims = Array.isArray(receipt.claimStatuses) ? receipt.claimStatuses : [];
  const warnings = Array.isArray(receipt.warnings) ? receipt.warnings : [];

  const hasAssuranceInsufficient = facets.some((x) => x.status === "assuranceInsufficient");
  const hasProcessed = facets.some((x) => x.status === "processed" || x.status === "written");
  const hasFailed = facets.some((x) => x.status === "consent-denied" || x.status === "trustTierUnsupported" || x.status === "assuranceInsufficient");
  const hasSealed = facets.some((x) => x.status === "opaque" || x.status === "consent-missing");
  const hasUnsupportedClaim = claims.some((x) => x.status === "trustTierUnsupported");

  if (hasAssuranceInsufficient && !hasProcessed) return "rejected";
  if (hasFailed || hasSealed || hasUnsupportedClaim) return "accepted-partial";
  if (warnings.length > 0) return "accepted-with-warnings";
  return "accepted";
}

/**
 * Finalize a composed receipt: apply the sticky rejection (any merged fragment
 * that rejected), compose the outcome, stamp processedAt (unless the pinned
 * evaluationContext says omitProcessedAt — the fixtures' determinism switch),
 * and enforce the shape contract (throws on violation — the hub fails closed;
 * a malformed receipt must never reach a consumer).
 */
export function finalizeReceipt(receipt, { rejected = false, outcomeOverride, now, omitProcessedAt = false } = {}) {
  receipt.outcome = isNonEmptyString(outcomeOverride)
    ? outcomeOverride
    : rejected
      ? "rejected"
      : composeOutcome(receipt);
  if (!omitProcessedAt) receipt.processedAt = isIsoDateTime(now) ? now : new Date().toISOString();
  const shape = validateReceiptShape(receipt);
  if (!shape.valid) throw new Error(`finalizeReceipt: canonical shape violated — ${shape.errors.join("; ")}`);
  return receipt;
}

// ===========================================================================
// 4) COMPARATOR — receipt vs an expected.json evaluation-mode entry
// ===========================================================================

/**
 * Compare a canonical receipt against EVERY receipt assertion present on a
 * conformance/v0.4/expected.json fixture entry (the full assertion surface:
 * expectedReceiptOutcome, expectedSignatureCheck, expectedFreshnessCheck,
 * expectedFacetStatus (incl. nested assuranceStatus), expectedConsentStatus,
 * expectedClaimStatus (incl. tier), expectedUnprocessedEntry,
 * expectedHolderBindingStatus, expectedPresentationProofStatus,
 * expectedKeyRefResolution, expectedLivenessFreshnessClass,
 * expectedEffectiveTrustTier, expectedWarningsContain).
 * Returns { ok, mismatches: string[] } — per-fixture bind point.
 */
export function assertReceiptAgainstExpectedEntry(receipt, entry) {
  const mismatches = [];
  const r = receipt || {};
  const e = entry || {};
  const want = (field, actual, expected) => {
    if (actual !== expected) mismatches.push(`${field}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  };

  if (e.expectedReceiptOutcome !== undefined) want("outcome", r.outcome, e.expectedReceiptOutcome);
  if (e.expectedSignatureCheck !== undefined) want("signatureCheck", r.signatureCheck, e.expectedSignatureCheck);
  if (e.expectedFreshnessCheck !== undefined) want("freshnessCheck", r.freshnessCheck, e.expectedFreshnessCheck);
  if (e.expectedHolderBindingStatus !== undefined) want("holderBindingStatus", r.holderBindingStatus, e.expectedHolderBindingStatus);
  if (e.expectedPresentationProofStatus !== undefined) want("presentationProofStatus", r.presentationProofStatus, e.expectedPresentationProofStatus);
  if (e.expectedKeyRefResolution !== undefined) want("keyRefResolution", r.keyRefResolution, e.expectedKeyRefResolution);
  if (e.expectedEffectiveTrustTier !== undefined) want("effectiveTrustTier", r.effectiveTrustTier, e.expectedEffectiveTrustTier);
  if (e.expectedLivenessFreshnessClass !== undefined) {
    want("livenessStatus.freshnessClass", r.livenessStatus?.freshnessClass, e.expectedLivenessFreshnessClass);
  }
  if (e.expectedFacetStatus !== undefined) {
    const x = e.expectedFacetStatus;
    const hit = (r.facetStatuses || []).find((f) => f.facetId === x.facetId);
    if (!hit) mismatches.push(`facetStatuses: no entry for facetId ${x.facetId}`);
    else {
      want(`facetStatuses[${x.facetId}].status`, hit.status, x.status);
      if (x.assuranceStatus !== undefined) {
        want(`facetStatuses[${x.facetId}].assuranceStatus.assertedClass`, hit.assuranceStatus?.assertedClass, x.assuranceStatus.assertedClass);
        want(`facetStatuses[${x.facetId}].assuranceStatus.met`, hit.assuranceStatus?.met, x.assuranceStatus.met);
      }
    }
  }
  if (e.expectedConsentStatus !== undefined) {
    const x = e.expectedConsentStatus;
    const hit = (r.consentStatuses || []).find((c) => c.consentRef === x.consentRef);
    if (!hit) mismatches.push(`consentStatuses: no entry for consentRef ${x.consentRef}`);
    else want(`consentStatuses[${x.consentRef}].status`, hit.status, x.status);
  }
  if (e.expectedClaimStatus !== undefined) {
    const x = e.expectedClaimStatus;
    const hit = (r.claimStatuses || []).find((c) => c.claimRef === x.claimRef);
    if (!hit) mismatches.push(`claimStatuses: no entry for claimRef ${x.claimRef}`);
    else {
      want(`claimStatuses[${x.claimRef}].status`, hit.status, x.status);
      if (x.tier !== undefined) want(`claimStatuses[${x.claimRef}].tier`, hit.tier, x.tier);
    }
  }
  if (e.expectedUnprocessedEntry !== undefined) {
    const x = e.expectedUnprocessedEntry;
    const hit = (r.unprocessedEntries || []).some((u) => u.kind === x.kind && u.type === x.type);
    if (!hit) mismatches.push(`unprocessedEntries: no {kind:${x.kind}, type:${x.type}} entry`);
  }
  if (Array.isArray(e.expectedWarningsContain)) {
    const codes = new Set((r.warnings || []).map((w) => w.code));
    for (const code of e.expectedWarningsContain) {
      if (!codes.has(code)) mismatches.push(`warnings: missing required code ${code}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// ===========================================================================
// 5) THE RECEIPT-EVENT CHAIN — single-manifest/session audit trail (R5/P17).
//    Fixture-local trace shape (factory-floor oracle) + on-wire events.
//    HASH-CHAINING IS NOT IMPLEMENTED HERE — reuses this chain shape and
//    adds seq/prevHash linkage + the departure seal (single-chain discipline).
// ===========================================================================

/**
 * Create a session-local receipt chain. flushPolicy "session-end" is the
 * factory-floor obligation: events accumulate and flush only at seal time.
 */
export function createReceiptChain({ subject, chainId, flushPolicy = "session-end" } = {}) {
  return {
    chainId: isNonEmptyString(chainId) ? chainId : `urn:um:chain:${randomHex(16)}`,
    ...(isNonEmptyString(subject) ? { subject } : {}),
    flushPolicy,
    createdAt: new Date().toISOString(),
    sealed: false,
    events: [],
  };
}

/**
 * Append ONE typed event. Enforces the minimizedReceiptObligations of the
 * factory-floor oracle, fail closed:
 *   · requiredFields — eventClass/subject/reason must be non-empty strings;
 *     seq is assigned here (monotonic from 1) and cannot be supplied.
 *   · forbiddenPayloads — a strict field WHITELIST (capability/target/
 *     facetKeyRef/at only) structurally excludes raw manifests, embedded
 *     credentials, decrypted facet contents, key material, ZKP material and
 *     source-adapter payloads. facetKeyRef must be a key *reference* URI.
 *   · flushPolicy — appending to a sealed chain throws (session-end).
 * eventClass is an EXTENSIBLE label (isCanonicalEventClass() covers the RP1 16
 * + the two PREVIEW key-lifecycle events + the fixture-local classes); pass
 * { strict: true } to reject non-canonical classes.
 */
export function appendChainEvent(chain, fields, { strict = false } = {}) {
  if (!chain || chain.sealed) throw new Error("appendChainEvent: chain is sealed (flushPolicy session-end) or missing");
  const f = fields || {};
  if ("seq" in f) throw new Error("appendChainEvent: seq is assigned by the chain, never supplied");
  for (const key of Object.keys(f)) {
    if (key === "eventClass" || key === "subject" || key === "reason") continue;
    if (!CHAIN_EVENT_OPTIONAL_FIELDS.includes(key)) {
      throw new Error(`appendChainEvent: field "${key}" is outside the minimized-receipt whitelist (forbiddenPayloads: ${CHAIN_FORBIDDEN_PAYLOADS.join(", ")})`);
    }
  }
  if (!isNonEmptyString(f.eventClass) || !isNonEmptyString(f.subject) || !isNonEmptyString(f.reason)) {
    throw new Error(`appendChainEvent: requiredFields ${CHAIN_EVENT_REQUIRED_FIELDS.join("/")} — eventClass, subject and reason must be non-empty strings`);
  }
  if (strict && !isCanonicalEventClass(f.eventClass)) {
    throw new Error(`appendChainEvent: "${f.eventClass}" is not a canonical event class (strict mode)`);
  }
  for (const key of ["capability", "target", "facetKeyRef"]) {
    if (f[key] !== undefined && !isNonEmptyString(f[key])) throw new Error(`appendChainEvent: ${key} must be a non-empty string when present`);
  }
  if (f.at !== undefined && !isIsoDateTime(f.at)) throw new Error("appendChainEvent: at must be ISO 8601 when present");

  const event = {
    seq: chain.events.length + 1, // monotonic from 1 — the trace-row ordinal,
    // NOT the EXT-OPT receipt-level hash-chain seq (that surface is).
    eventClass: f.eventClass,
    subject: f.subject,
    ...(f.capability !== undefined ? { capability: f.capability } : {}),
    ...(f.target !== undefined ? { target: f.target } : {}),
    ...(f.facetKeyRef !== undefined ? { facetKeyRef: f.facetKeyRef } : {}),
    reason: f.reason,
    ...(f.at !== undefined ? { at: f.at } : {}),
  };
  chain.events.push(event);
  return event;
}

/** Seal the chain at session end. NO hash is computed here — adds the
 *  hash-chain seal (canonicalManifestHash convention, see module header). */
export function sealReceiptChain(chain, { at } = {}) {
  if (!chain || chain.sealed) throw new Error("sealReceiptChain: chain missing or already sealed");
  chain.sealed = true;
  chain.sealedAt = isIsoDateTime(at) ? at : new Date().toISOString();
  return chain;
}

/** The fixture-local trace rows (factory-floor shape): strips chain metadata
 *  and the optional `at` so rows compare 1:1 with expected-receipt-trace.json. */
export function chainTraceRows(chain) {
  return (chain?.events || []).map(({ at, ...row }) => ({ ...row }));
}

/**
 * Convert chain events to the ON-WIRE receipt `events[]` shape (schema.jsonld
 * terms: eventType, at, subjectRef, facetKeyRef, reason). `capability`/`target`
 * are fixture-local trace-row fields with NO context term yet — they stay on
 * the trace rows and are NOT emitted on the wire (no invented vocabulary).
 */
export function chainToReceiptEvents(chain, { defaultAt } = {}) {
  const fallbackAt = isIsoDateTime(defaultAt) ? defaultAt : chain?.sealedAt || new Date().toISOString();
  return (chain?.events || []).map((e) => ({
    eventType: e.eventClass,
    at: isIsoDateTime(e.at) ? e.at : fallbackAt,
    subjectRef: e.subject,
    ...(e.facetKeyRef !== undefined ? { facetKeyRef: e.facetKeyRef } : {}),
    reason: e.reason,
  }));
}

// ===========================================================================
// 6) FACTORY-FLOOR 3-PATH MIRROR — the task acceptance oracle, rebuilt through
//    the chain machinery (validated appends), NOT replayed from the fixture.
// ===========================================================================

const FF_USER = "did:peer:2.Ez6LRp1FactoryFloorSafetyPairwiseUserProjection";
const FF_SERVICE = "did:web:factory.example.com:services:floor-safety";
const FF_PACKAGE = "did:web:factory-services.example.com:packages:floor-safety-v2";
const FF_KEYREF_BASE = "urn:um:facet-key:fixture:factory-floor-policy-vector:safety-certification";

/**
 * Rebuild the factory-floor expected-receipt-trace 3 paths (positive / denial /
 * renewal-revocation-session-unlock) through createReceiptChain/appendChainEvent.
 * Returns { positive, denial, "renewal-revocation-session-unlock" } as trace-row
 * arrays — the verifier deep-compares them against the READ-ONLY fixture oracle.
 * Fixture-local shape; NOT a live audit claim (fixtureNote honored).
 */
export function buildFactoryFloorTraces() {
  const positive = createReceiptChain({ subject: FF_USER });
  appendChainEvent(positive, { eventClass: "session-admitted", subject: FF_USER, reason: "bilateral-authorisation-completed" });
  appendChainEvent(positive, { eventClass: "policy-override-applied", subject: FF_SERVICE, reason: "mandatory-non-dismissable-safety-overlay" });
  appendChainEvent(positive, { eventClass: "capability-granted", subject: FF_USER, capability: "credential.verify", target: "safetyCertification", reason: "safety-certification-validation-required" });
  appendChainEvent(positive, { eventClass: "capability-granted", subject: FF_USER, capability: "som.access", target: "/factory/floor-2/safety-service/**", reason: "equipment-access-granted" });
  appendChainEvent(positive, { eventClass: "terms-acknowledged", subject: FF_USER, reason: "terms-v1-accepted" });
  appendChainEvent(positive, { eventClass: "package-trusted", subject: FF_PACKAGE, reason: "package-status-trusted-and-fresh" });
  appendChainEvent(positive, { eventClass: "shader-trusted", subject: FF_PACKAGE, target: "../../artifacts/highlight.spv.fixture", reason: "spir-v-artifact-hash-matched" });
  appendChainEvent(positive, { eventClass: "capability-granted", subject: FF_SERVICE, capability: "inter-service.message", target: "hazard-reroute", reason: "authorized-inter-service-hazard-reroute-message" });
  appendChainEvent(positive, { eventClass: "policy-override-applied", subject: FF_SERVICE, reason: "non-dismissable-safety-overlay-enforced" });
  appendChainEvent(positive, { eventClass: "departure", subject: FF_USER, reason: "session-completed" });
  sealReceiptChain(positive);

  const denial = createReceiptChain({ subject: FF_SERVICE });
  appendChainEvent(denial, { eventClass: "package-rejected", subject: FF_SERVICE, target: "com.example.factory.social-overlay", reason: "prohibited-social-advertising-overlay-package" });
  appendChainEvent(denial, { eventClass: "capability-denied", subject: FF_SERVICE, capability: "overlay.compose", reason: "overlay-composition-not-permitted-on-safety-floor" });
  appendChainEvent(denial, { eventClass: "capability-denied", subject: FF_SERVICE, capability: "sensor.cameraPassthrough", reason: "camera-passthrough-not-requested-and-denied" });
  appendChainEvent(denial, { eventClass: "capability-denied", subject: FF_SERVICE, capability: "sensor.roomGeometry", reason: "room-geometry-not-requested-and-denied" });
  sealReceiptChain(denial);

  const renewal = createReceiptChain({ subject: FF_USER });
  appendChainEvent(renewal, { eventClass: "session-unlocked", subject: FF_USER, reason: "bounded-private-data-window-opened" });
  appendChainEvent(renewal, { eventClass: "capability-granted", subject: FF_USER, capability: "service.projection.renew", target: "safety-service", reason: "renewed-service-projection" });
  appendChainEvent(renewal, { eventClass: "capability-revoked", subject: FF_PACKAGE, capability: "package.trust", target: "com.example.factory.floor-safety", reason: "package-or-service-handle-revoked" });
  appendChainEvent(renewal, { eventClass: "facet-key-rotated", subject: FF_USER, facetKeyRef: `${FF_KEYREF_BASE}#rot-1`, reason: "scheduled-facet-key-rotation" });
  appendChainEvent(renewal, { eventClass: "facet-key-shredded", subject: FF_USER, facetKeyRef: `${FF_KEYREF_BASE}#rot-0`, reason: "prior-facet-key-shredded" });
  sealReceiptChain(renewal);

  return {
    positive: chainTraceRows(positive),
    denial: chainTraceRows(denial),
    "renewal-revocation-session-unlock": chainTraceRows(renewal),
  };
}

// ===========================================================================
// 7) BILATERAL SURFACE (Base §4 field surface only) + THE SEAM
// ===========================================================================

/** Mint an exchange correlation token: 128 bits of crypto entropy, encoding NO
 *  party identifiers (v0.4 README security: bilateral correlation tokens). */
export function mintExchangeId() {
  return `urn:um:exchange:${randomHex(16)}`;
}

/** Stamp the bilateral pair every in-session receipt MUST carry (CONFORMANCE §4).
 * session object is the caller; the demo calls it directly for P12. */
export function stampBilateral(receipt, { exchangeId, evaluatorId } = {}) {
  if (!isNonEmptyString(exchangeId) || !isNonEmptyString(evaluatorId)) {
    throw new Error("stampBilateral: exchangeId and evaluatorId are both required (CONFORMANCE Section 4)");
  }
  receipt.exchangeId = exchangeId;
  receipt.evaluatorId = evaluatorId;
  return receipt;
}

/**
 * P12: correlate the DUAL receipts of one crossing — both parties evaluated the
 * other's manifest; both receipts share ONE minted exchangeId and carry their
 * own evaluatorId. Pure stamping — evaluation itself is the engines' job.
 */
export function correlateDualReceipts(receiptA, receiptB, { exchangeId, evaluatorIdA, evaluatorIdB } = {}) {
  const xid = isNonEmptyString(exchangeId) ? exchangeId : mintExchangeId();
  stampBilateral(receiptA, { exchangeId: xid, evaluatorId: evaluatorIdA ?? receiptA.evaluatorId });
  stampBilateral(receiptB, { exchangeId: xid, evaluatorId: evaluatorIdB ?? receiptB.evaluatorId });
  if (receiptA.evaluatorId === receiptB.evaluatorId) {
    throw new Error("correlateDualReceipts: the two receipts must come from DISTINCT evaluators");
  }
  return { exchangeId: xid, receipts: [receiptA, receiptB] };
}

/**
 * THE WRITE SEAM for the EXT-OPT §O4 PREVIEW hash-chain fields. This hub
 * validates the shapes but NEVER computes prevHash — owns the single
 * chain (canonicalManifestHash over the WHOLE receipt manifest INCLUDING its
 * signature; see module header for the two-hash-convention warning).
 */
export function reserveChainLinkFields(receipt, { seq, prevHash, chainId } = {}) {
  if (seq !== undefined) {
    if (!(Number.isInteger(seq) && seq >= 0)) throw new Error("reserveChainLinkFields: seq must be a non-negative integer");
    receipt.seq = seq;
  }
  if (prevHash !== undefined) {
    if (prevHash !== null && !/^sha256:[0-9a-f]{64}$/.test(String(prevHash))) {
      throw new Error('reserveChainLinkFields: prevHash must be "sha256:<64 hex>" or null (genesis)');
    }
    receipt.prevHash = prevHash;
  }
  if (chainId !== undefined) {
    if (!isNonEmptyString(chainId)) throw new Error("reserveChainLinkFields: chainId must be a non-empty string");
    receipt.chainId = chainId;
  }
  return receipt;
}

// ===========================================================================
// 8) P16/P17 FACETS + THE DEPARTURE MANIFEST (R5/R11 demo surface)
// ===========================================================================

/**
 * P16 — the receipt-expectations facet: what the holder expects of the receipts
 * a world will issue about it (mirrors the factory-floor oracle's
 * minimizedReceiptObligations + the §2.5 required receipt members).
 * Demo-local profile label; NOT a registered UM profile.
 */
export function buildReceiptExpectationsFacet({ id } = {}) {
  return {
    "@id": isNonEmptyString(id) ? id : `urn:um:facet:receipt-expectations:${globalThis.crypto.randomUUID()}`,
    "@type": "um:Facet",
    name: "receiptExpectations",
    entity: {
      "@type": "um:Entity",
      profile: "wow-receipt-expectations-v1", // demo-local label, not a registered profile
      expectedReceiptMembers: ["@type", "manifestId", "outcome", "signatureCheck", "freshnessCheck", "facetStatuses"],
      expectedOutcomes: [...RECEIPT_OUTCOMES],
      hashChainRequired: true, // satisfied's chain, not by this hub
      requiredFields: [...CHAIN_EVENT_REQUIRED_FIELDS],
      forbiddenPayloads: [...CHAIN_FORBIDDEN_PAYLOADS],
      flushPolicy: "session-end",
    },
  };
}

/**
 * P17 — the receipt-chain facet: carries a (sealed) chain's trace rows on a
 * manifest. The hash-chain seal fields are PRESENT but null — fills them
 * (single-chain discipline). eventCount + sealed make tampering page-visible.
 */
export function buildReceiptChainFacet(chain, { id } = {}) {
  if (!chain || !Array.isArray(chain.events)) throw new Error("buildReceiptChainFacet: a receipt chain is required");
  return {
    "@id": isNonEmptyString(id) ? id : `urn:um:facet:receipt-chain:${globalThis.crypto.randomUUID()}`,
    "@type": "um:Facet",
    name: "receiptChain",
    entity: {
      "@type": "um:Entity",
      chainId: chain.chainId,
      flushPolicy: chain.flushPolicy,
      sealed: chain.sealed === true,
      ...(chain.sealedAt ? { sealedAt: chain.sealedAt } : {}),
      eventCount: chain.events.length,
      events: chainTraceRows(chain),
      // SEAM — hash-chain seal (EXT-OPT O4 PREVIEW). Null until
      // computes the canonicalManifestHash linkage; this hub never fills these.
      seq: null,
      prevHash: null,
      sealSignature: null,
    },
  };
}

/**
 * R5/R11 — the DEPARTURE MANIFEST DRAFT: a v0.4 um:Manifest carrying the sealed
 * receipt-chain facet, ready for Profile A signing. The chain must be
 * sealed first (flushPolicy session-end). Hash-chain linkage inside the facet
 * remains (this draft is the enterprise audit-trail demo surface).
 */
export function buildDepartureManifestDraft(chain, { subject, issuedAt, ttlSeconds = 3600, id } = {}) {
  if (!chain?.sealed) throw new Error("buildDepartureManifestDraft: seal the chain first (flushPolicy session-end)");
  if (!isNonEmptyString(subject)) throw new Error("buildDepartureManifestDraft: subject (the departing entity's DID) is required");
  const issued = isIsoDateTime(issuedAt) ? issuedAt : new Date().toISOString();
  return {
    "@context": UM_V04_CONTEXT,
    "@id": isNonEmptyString(id) ? id : mintUrnUuid(),
    "@type": "um:Manifest",
    manifestVersion: UM_V04_MANIFEST_VERSION,
    subject,
    issuedAt: issued,
    expiresAt: new Date(Date.parse(issued) + ttlSeconds * 1000).toISOString(),
    facets: [buildReceiptChainFacet(chain)],
  };
}

/** Sign a departure draft with Signature Profile A. */
export async function sealDepartureManifest(chain, { subject, issuedAt, ttlSeconds, id, privateKeyInput, keyRef } = {}) {
  const draft = buildDepartureManifestDraft(chain, { subject, issuedAt, ttlSeconds, id });
  return attachSignatureProfileA(draft, privateKeyInput, keyRef ? { keyRef } : {});
}

// ===========================================================================
// 9) RECEIPT-AS-MANIFEST PROMOTION (EXT-OPT receipts-as-a-class — PREVIEW).
//    Wire shape pinned by valid/receipt-facet-key-shredded.jsonld:
//    envelope members + @type ["um:Manifest","um:Receipt"] + receipt members.
// ===========================================================================

/** Acceptance/severity ranking of the 4 outcomes for the emit fail-closed
 *  check: a receipt may STATE a more-severe outcome than its evidence derives
 *  (fail-closed direction — e.g. a sticky-rejected verdict whose facetStatuses
 *  alone would compose "accepted"), but NEVER a more-accepting one. */
const OUTCOME_SEVERITY = Object.freeze({ rejected: 3, "accepted-partial": 2, "accepted-with-warnings": 1, accepted: 0 });

export function promoteReceiptToManifest(receipt, { subject, issuedAt, ttlSeconds = 3600, id, outcomeOverride } = {}) {
  if (!isNonEmptyString(subject)) throw new Error("promoteReceiptToManifest: subject (the EVALUATOR's DID) is required");
  const shape = validateReceiptShape(receipt);
  if (!shape.valid) throw new Error(`promoteReceiptToManifest: receipt shape invalid — ${shape.errors.join("; ")}`);
  // EMIT FAIL-CLOSED (hardening F4): re-derive the outcome from the receipt's
  // own evidence and REFUSE to put a more-accepting stated outcome on the wire.
  // finalizeReceipt is the composing keystone, but nothing enforced finalize-
  // before-emit: a hand-built {outcome:"accepted"} over reject-worthy
  // facetStatuses passed validateReceiptShape (members/enums only) and was
  // promoted + Profile A signed verbatim. A deliberate divergence (the
  // backcompat lever) must be attested EXPLICITLY by passing
  // outcomeOverride === receipt.outcome in the envelope — the divergence is
  // thereby recorded at the emit call site, never silent.
  const derived = composeOutcome(receipt);
  if ((OUTCOME_SEVERITY[receipt.outcome] ?? -1) < OUTCOME_SEVERITY[derived] && outcomeOverride !== receipt.outcome) {
    throw new Error(
      `promoteReceiptToManifest: stated outcome "${receipt.outcome}" is more accepting than the diagnostics-derived outcome "${derived}" — ` +
        "finalize the receipt (finalizeReceipt) before emit, or attest the divergence with an explicit envelope outcomeOverride"
    );
  }
  const issued = isIsoDateTime(issuedAt) ? issuedAt : new Date().toISOString();
  const { "@type": _t, ...members } = receipt;
  return {
    "@context": UM_V04_CONTEXT,
    "@id": isNonEmptyString(id) ? id : mintUrnUuid(),
    "@type": ["um:Manifest", "um:Receipt"],
    manifestVersion: UM_V04_MANIFEST_VERSION,
    subject,
    issuedAt: issued,
    expiresAt: new Date(Date.parse(issued) + ttlSeconds * 1000).toISOString(),
    ...members,
  };
}

/** Promote + Profile A sign in one step (receipts MAY be signed — Base §3.1.6).
 *  Inherits promoteReceiptToManifest's emit fail-closed outcome cross-check
 *  (hardening F4) — the envelope, incl. an attesting outcomeOverride, passes
 *  through, so a more-accepting-than-evidence outcome is never signed. */
export async function signReceiptManifest(receipt, envelope = {}, privateKeyInput, opts = {}) {
  const manifest = promoteReceiptToManifest(receipt, envelope);
  return attachSignatureProfileA(manifest, privateKeyInput, opts);
}

// ===========================================================================
// 10) DEMO PANEL ROW — the API_EVENTS surface record (integration is the
//     a serialized live-adapter.js/app.js edit; see the result
//     artifact for the exact wiring lines).
// ===========================================================================

/** A compact, read-only telemetry row for the API_EVENTS request-log panel. */
export function receiptPanelRecord(receipt, { label } = {}) {
  const facets = Array.isArray(receipt.facetStatuses) ? receipt.facetStatuses : [];
  return {
    kind: "um-receipt",
    ...(isNonEmptyString(label) ? { label } : {}),
    manifestId: receipt.manifestId,
    outcome: receipt.outcome,
    signatureCheck: receipt.signatureCheck,
    freshnessCheck: receipt.freshnessCheck,
    ...(receipt.evaluatorId ? { evaluatorId: receipt.evaluatorId } : {}),
    ...(receipt.exchangeId ? { exchangeId: receipt.exchangeId } : {}),
    facetsProcessed: facets.filter((f) => f.status === "processed" || f.status === "written").length,
    facetsWithheld: facets.filter((f) => f.status !== "processed" && f.status !== "written").length,
    warningCount: (receipt.warnings || []).length,
    at: new Date().toISOString(),
  };
}

// ===========================================================================
// 11) HONESTY DESCRIPTOR — what this module claims and does not claim.
// ===========================================================================

export const feature_RECEIPT_CONFORMANCE = Object.freeze({
  wo: "runtime",
  scoped_claim:
    "canonical v0.4 um:Receipt container (MUST 2.5 members + MUST 2.6 8-value facet statuses + " +
    "extended disposition fields + warnings{code,message}) and the single-manifest receipt-event " +
    "chain shape (factory-floor trace oracle mirrored 3/3 paths)",
  preview_features: Object.freeze([
    "receipts-as-a-first-class-manifest-class (@type [um:Manifest,um:Receipt]) — EXT-OPT PREVIEW",
    "receipt hash-chaining seq/prevHash/chainId — surface RESERVED, computed ONLY by runtime",
    "bilateral exchangeId/evaluatorId — Base field surface; full session object is runtime",
    "key-lifecycle events facet-key-rotated/facet-key-shredded — appended by runtime",
  ]),
  not_claimed: Object.freeze([
    "NO um_conformance flag is flipped by this module",
    "the RP1 16-class taxonomy is page/fixture narrative over um:Receipt, not a normative class hierarchy",
    "the factory-floor trace is a fixture oracle, not a live review claim",
    "bilateral-session hash-chaining across two parties is runtime, not this module",
    "the full six-stage matrix run over all 72 fixtures is runtime, not this module",
  ]),
  hash_conventions: Object.freeze({
    chain: "canonicalManifestHash (runtime-projection.mjs): deep-key-sorted JSON over the WHOLE document INCLUDING signature",
    signing_input: "JCS RFC-8785 with {signature, postQuantumSignature, presentationProof} excluded (runtime/119)",
  }),
});

// END
