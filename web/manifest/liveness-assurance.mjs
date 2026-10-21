// v0.4 liveness attestation + per-facet liveness/assurance
// floors — fail-closed enforcement (PREVIEW-labeled).
//
// This module is the EXT-T1 T1.3 owner for the demo:
//   liveness freshness classification    — EXT-T1 §T1.3 (live|recent|stale|unknown)
//   per-facet liveness floor             — EXT-T1 §T1.3.1 (requiredLiveness) PREVIEW
//   per-facet assurance-class floor      — EXT-T1 §T1.3.3 (requiredAssuranceClass) PREVIEW
//   stale-replay adversarial MUST        — CONFORMANCE §2.11 / §6.5 (past validUntil ⇒ unknown)
//   fail-closed floor baseline           — CONFORMANCE §2.13 / §2.14 (unenforced ⇒ withheld)
//
// Spec sources (READ-ONLY, ):
//   spec/v0.4/schema.json              $defs.livenessAttestation / $defs.requiredLiveness
//                                      (requiredLiveness is a CLOSED compound —
//                                      additionalProperties:false) / facet requiredAssuranceClass
//   spec/v0.4/CONFORMANCE.md           §2.6 (closed 8-value facet status set), §2.11,
//                                      §2.13, §2.14, §3.7, §6.5, §9
//   docs/spec-v0.4/ext-t1.html         T1.3 / T1.3.1 / T1.3.2 / T1.3.3
//   docs/spec-v0.4/core.html           Base §3.1.4 (gate order sealed-entry → consent →
//                                      floors; floors evaluated with consent), §3.3.1/.1
//   conformance/v0.4/expected.json     the 12 fixture entries this change owns
//   packages/universal-manifest/src/index.ts  classifyLivenessFreshness (reference
//                                      thresholds: live ≤60s, recent ≤4h, stale within
//                                      validUntil; past/unparseable validUntil ⇒ unknown)
//
// RECEIPT DISCIPLINE: this module writes INTO the canonical
// um:Receipt container owned by receipt-hub.mjs — the reserved fields
//   livenessStatus:  { freshnessClass: live|recent|stale|unknown, method?, userVerified? }
//   facetStatuses[]: { ..., status: "assuranceInsufficient",
//                      assuranceStatus?: { assertedClass, met } }
// via createReceipt → mergeFragment → finalizeReceipt. The receipt shape is NOT
// forked here; buildWo135Fragment is the composition surface
// (recommended merge order: tier(133) → assurance(135) → sealed(132) →
// consent(122) → projection(123) — result artifact).
//
// ---------------------------------------------------------------------------
// HONESTY CEILING — what is REAL vs PREVIEW/fail-closed (machine-readable
// descriptor: feature_CONFORMANCE below; every `real:true` is exercised by
// web/manifest/verify.mjs against the external suite or live crypto):
//   REAL   freshness classification      — reference-parity classifier (live ≤60s,
//                                          recent ≤4h, stale within validUntil; past or
//                                          unparseable validUntil ⇒ unknown, fail closed);
//                                          proven against the reference vector set.
//   REAL   structural shape validation   — livenessAttestation (4 REQUIRED members),
//                                          requiredLiveness (closed compound,
//                                          additionalProperties:false), requiredAssuranceClass
//                                          (closed 3-value enum) — schema.json parity.
//   REAL   demo-attester crypto          — Ed25519 over UTF-8(subject || attestedAt)
//                                          (schema.json proofValue recipe), issue + verify.
//                                          LABEL: "demo attester — proves attestation
//                                          handling, not human presence."
//   CLOSED webauthn-uv (and every other   — NO WebAuthn assertion validation exists here.
//          non-demo proofType)             For FLOOR purposes such attestations are never
//                                          "validated" ⇒ no floor is ever met by them
//                                          (T1.3.1: proof validation strictly before
//                                          freshness). The receipt freshness ECHO is still
//                                          recorded (T1.3 echo semantics, reference parity)
//                                          — an echo is not a floor decision and never
//                                          releases a facet.
//   PREVIEW liveness floor enforcement   — T1.3.1 is PREVIEW in the source spec. A floor
//                                          unmet/unvalidated/unknown ⇒ facet WITHHELD,
//                                          recorded with the below-floor refusal status
//                                          "assuranceInsufficient" (T1.3.3 names it the
//                                          below-floor refusal status; the closed §2.6
//                                          set has no liveness-specific value — mapping
//                                          decision documented, no fixture pins it).
//   PREVIEW assurance floor enforcement  — presentedAssuranceClass is a CALLER input
//                                          (fixture-pinned evaluationContext), defaulted
//                                          fail-closed to "software". This module verifies
//                                          NO hardware provenance (no deviceAttestation /
//                                          WebAuthn BE/BS mechanics — T1.3.2): a demo
//                                          presented class above "software" is a simulated
//                                          unlock toggle and is labeled as such. Below
//                                          floor ⇒ withheld, "assuranceInsufficient",
//                                          assuranceStatus echo {assertedClass, met:false},
//                                          NEVER downgraded (§2.14).
//   FAIL-CLOSED baseline                 — floor enforcement disabled (enforceFloors:false)
//                                          ⇒ floor-bearing facets are STILL withheld, never
//                                          processed (§2.13/§2.14 unenforced-evaluator rule).
// This module flips NO um_conformance flag. Grade-2 carry-only. Scope: the 12
// fixtures + the locked-facet demo surface. NOT consent semantics
//NOT trust tiers, NOT sealed facets, NOT the full
// six-stage evaluator.
// ---------------------------------------------------------------------------
//
// FILE DISCIPLINE: NEW, specific module. Imports the receipt hub
// (canonical container — the task dependency) and the signing library
// (read-only reuse, same as). Imported by nothing yet. Registration into
// a composed v0.4 runner is via registerWo135() — one wiring line, applied by
// the integration step, not by this module. The v0.1 gate
// (web/conformance/run-um-conformance.mjs) is NOT touched.

import {
  createReceipt,
  mergeFragment,
  finalizeReceipt,
  receiptPanelRecord,
  LIVENESS_FRESHNESS_CLASSES,
} from "./receipt-hub.mjs";
import { verifyManifestProfileA, attachSignatureProfileA } from "../signing/um-signature-profile-a.mjs";
import { generateKeyPair, signBytes, verifyBytes } from "../signing/ed25519.mjs";
import { utf8Encode, bytesToBase64Url } from "../signing/codecs.mjs";

// ===========================================================================
// Constants (schema.json $defs + EXT-T1 value sets)
// ===========================================================================

export { LIVENESS_FRESHNESS_CLASSES }; // hub-owned closed set: live|recent|stale|unknown

/** Valid per-facet liveness floor classes (T1.3.1 — "unknown" is not a valid floor). */
export const REQUIRED_LIVENESS_FRESHNESS = Object.freeze(["live", "recent", "stale"]);

/** Freshness comparison order live > recent > stale > unknown (T1.3.1). */
export const LIVENESS_FRESHNESS_RANK = Object.freeze({ live: 3, recent: 2, stale: 1, unknown: 0 });

/** Closed assurance ladder software < hardware-uv < hardware-bound (T1.3.3). */
export const ASSURANCE_CLASSES = Object.freeze(["software", "hardware-uv", "hardware-bound"]);
export const ASSURANCE_CLASS_RANK = Object.freeze({ software: 0, "hardware-uv": 1, "hardware-bound": 2 });

/** Reference classifier thresholds (EXT-T1 §T1.3; reference impl parity). */
export const LIVE_WINDOW_MS = 60_000;
export const RECENT_WINDOW_MS = 4 * 3600_000;

/** The ONLY proofType this module can cryptographically validate (labeled demo). */
export const DEMO_LIVENESS_PROOF_TYPE = "demo-ed25519";
export const DEMO_ATTESTER_LABEL =
  "demo attester — proves attestation handling, not human presence";

// Machine-readable scoped-claim descriptor (pattern: feature_CONFORMANCE).
export const feature_CONFORMANCE = Object.freeze({
  wo: "runtime",
  standard:
    "Universal Manifest v0.4 EXT-T1 T1.3 (liveness attestation) + T1.3.1/T1.3.3 per-facet floors (PREVIEW)",
  fixtures_owned: 12,
  // REAL surfaces:
  freshness_classification_real: true, // reference-parity classifier, vectored in verify.mjs
  stale_replay_fail_closed_real: true, // past/unparseable validUntil ⇒ unknown (CONFORMANCE §2.11/§6.5)
  structural_shape_validation_real: true, // schema.json $defs parity incl. closed requiredLiveness compound
  demo_attester_crypto_real: true, // Ed25519 over UTF-8(subject||attestedAt) — issue + verify (LABELED demo)
  // PREVIEW / fail-closed surfaces (NEVER reported met without backing):
  liveness_floor_enforcement: "PREVIEW", // T1.3.1 PREVIEW; unmet/unknown/unvalidated ⇒ withheld
  assurance_floor_enforcement: "PREVIEW", // T1.3.3 PREVIEW; below floor ⇒ assuranceInsufficient, never downgraded
  webauthn_uv_proof_validation: false, // NO WebAuthn mechanics ⇒ never satisfies a floor (fail closed)
  hardware_provenance_verification: false, // NO deviceAttestation/BE-BS mechanics (T1.3.2) ⇒ presented class is caller input
  biometric_or_human_presence_claimed: false, // structural + freshness classification ONLY
  fail_closed_unenforced_baseline: true, // enforceFloors:false ⇒ floor-bearing facets withheld, never processed
  full_six_stage_evaluator: false, // composes; this is the T1.3 slice
  um_conformance_flag_flipped: false,
  scoped_claim:
    "runtime implements REAL liveness freshness classification (reference-parity, fail-closed on " +
    "expired/unparseable validity), REAL structural validation for livenessAttestation/" +
    "requiredLiveness/requiredAssuranceClass, and PREVIEW fail-closed enforcement of both per-facet " +
    "floors: unmet/unknown floors withhold the facet (assuranceInsufficient) and are never downgraded. " +
    "The only cryptographically validated attestation is the LABELED demo attester (Ed25519 over " +
    "subject||attestedAt); webauthn-uv and every other proofType never satisfy a floor here. No " +
    "biometric capture and no human presence is claimed or implied.",
});

// ===========================================================================
// Small helpers
// ===========================================================================

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isIsoDateTime(v) {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
export function isAssuranceClass(v) {
  return ASSURANCE_CLASSES.includes(v);
}

// ===========================================================================
// 1) STRUCTURAL SURFACE — shape validation (schema.json $defs parity)
// ===========================================================================

/**
 * Validate a root-level livenessAttestation per schema.json
 * $defs.livenessAttestation + EXT-T1 §T1.3: proofType/attestedAt/validUntil/
 * proofValue REQUIRED; method/userVerified/attester OPTIONAL (typed);
 * additionalProperties allowed. Returns { valid, errors } — error strings
 * mirror the reference implementation's diagnostics.
 */
export function validateLivenessAttestationShape(att) {
  const errors = [];
  if (!isPlainObject(att)) return { valid: false, errors: ["livenessAttestation must be an object"] };
  if (!isNonEmptyString(att.proofType)) errors.push("livenessAttestation.proofType is required");
  if (!isIsoDateTime(att.attestedAt)) errors.push("livenessAttestation.attestedAt must be an ISO 8601 date-time");
  if (att.validUntil === undefined) errors.push("livenessAttestation.validUntil is required");
  else if (!isIsoDateTime(att.validUntil)) errors.push("livenessAttestation.validUntil must be an ISO 8601 date-time");
  if (!isNonEmptyString(att.proofValue)) errors.push("livenessAttestation.proofValue is required");
  if (att.method !== undefined && typeof att.method !== "string") errors.push("livenessAttestation.method must be a string");
  if (att.userVerified !== undefined && typeof att.userVerified !== "boolean") {
    errors.push("livenessAttestation.userVerified must be a boolean");
  }
  if (att.attester !== undefined && typeof att.attester !== "string") errors.push("livenessAttestation.attester must be a string");
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a facet's requiredLiveness floor per schema.json $defs.requiredLiveness
 * + EXT-T1 §T1.3.1: a CLOSED compound (additionalProperties:false) — exactly
 * minFreshness (REQUIRED, live|recent|stale; "unknown" is not a valid floor)
 * plus the OPTIONAL boolean userVerified. NOT a mirror of the closed-integer
 * requiredTrustTier. Returns { valid, errors }.
 */
export function validateRequiredLivenessShape(rl) {
  if (!isPlainObject(rl)) return { valid: false, errors: ["requiredLiveness must be an object"] };
  const errors = [];
  if (!REQUIRED_LIVENESS_FRESHNESS.includes(rl.minFreshness)) {
    errors.push("requiredLiveness.minFreshness must be one of live|recent|stale");
  }
  if (rl.userVerified !== undefined && typeof rl.userVerified !== "boolean") {
    errors.push("requiredLiveness.userVerified must be a boolean");
  }
  for (const key of Object.keys(rl)) {
    if (key !== "minFreshness" && key !== "userVerified") {
      errors.push(`requiredLiveness is a closed compound (additionalProperties: false) — unexpected member "${key}"`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a facet's requiredAssuranceClass per the v0.4 facet schema +
 * EXT-T1 §T1.3.3: the closed 3-value string enum. Returns { valid, errors }.
 */
export function validateRequiredAssuranceClassShape(v) {
  if (!isAssuranceClass(v)) {
    return { valid: false, errors: ["requiredAssuranceClass must be one of software|hardware-uv|hardware-bound"] };
  }
  return { valid: true, errors: [] };
}

/**
 * The structural slice over a whole manifest: root livenessAttestation
 * (when present) + every facet's requiredLiveness / requiredAssuranceClass
 * (when present). Returns { valid, errors }.
 */
export function validateWo135Structural(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return { valid: false, errors: ["manifest must be an object"] };
  if (manifest.livenessAttestation !== undefined) {
    errors.push(...validateLivenessAttestationShape(manifest.livenessAttestation).errors);
  }
  const facets = Array.isArray(manifest.facets) ? manifest.facets : [];
  facets.forEach((facet, i) => {
    if (!isPlainObject(facet)) return;
    const at = isNonEmptyString(facet["@id"]) ? facet["@id"] : `facets[${i}]`;
    if (facet.requiredLiveness !== undefined) {
      errors.push(...validateRequiredLivenessShape(facet.requiredLiveness).errors.map((e) => `${at}: ${e}`));
    }
    if (facet.requiredAssuranceClass !== undefined) {
      errors.push(...validateRequiredAssuranceClassShape(facet.requiredAssuranceClass).errors.map((e) => `${at}: ${e}`));
    }
  });
  return { valid: errors.length === 0, errors };
}

// Envelope basics shared by every v0.4 structural verdict (same rule set as the
// sibling engines; kept local — modules are disjoint by file discipline).
function envelopeErrors(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return ["manifest must be an object"];
  const ctx = manifest["@context"];
  const hasV04 =
    ctx === "https://universalmanifest.net/ns/v0.4" ||
    (Array.isArray(ctx) && ctx.includes("https://universalmanifest.net/ns/v0.4"));
  if (!hasV04) errors.push("@context must include https://universalmanifest.net/ns/v0.4 (Section 1.2.1)");
  if (!isNonEmptyString(manifest["@id"])) errors.push("Missing @id");
  const t = manifest["@type"];
  const hasType = t === "um:Manifest" || (Array.isArray(t) && t.includes("um:Manifest"));
  if (!hasType) errors.push("Missing um:Manifest in @type");
  if (manifest.manifestVersion !== "0.4") errors.push("manifestVersion must be 0.4");
  if (!isNonEmptyString(manifest.subject)) errors.push("Missing subject");
  if (!isIsoDateTime(manifest.issuedAt)) errors.push("issuedAt must be an ISO 8601 date-time");
  if (!isIsoDateTime(manifest.expiresAt)) errors.push("expiresAt must be an ISO 8601 date-time");
  if (isIsoDateTime(manifest.issuedAt) && isIsoDateTime(manifest.expiresAt) && Date.parse(manifest.issuedAt) > Date.parse(manifest.expiresAt)) {
    errors.push("issuedAt must be <= expiresAt");
  }
  return errors;
}

/**
 * STRUCTURAL verdict for a fixture (clock-independent): envelope +
 * shapes, signature LAST (shape defects report their own reason, not a
 * crypto one — mirrors the sibling structural verdicts).
 */
export async function structuralVerdictWo135(manifest) {
  const reasons = [];
  reasons.push(...envelopeErrors(manifest));
  if (reasons.length === 0) reasons.push(...validateWo135Structural(manifest).errors);
  let sigReport = null;
  if (reasons.length === 0) {
    sigReport = await verifyManifestProfileA(manifest);
    if (!sigReport.ok) reasons.push(`signature verification failed: ${sigReport.reason}`);
  }
  return {
    result: reasons.length === 0 ? "accept" : "reject",
    reasons,
    checks: { signature: sigReport ? sigReport.reason : "not-evaluated" },
  };
}

// ===========================================================================
// 2) FRESHNESS CLASSIFICATION — EXT-T1 §T1.3 (reference-parity, fail closed)
// ===========================================================================

/**
 * Classify a liveness attestation's freshness per EXT-T1 §T1.3 (reference
 * implementation parity — packages/universal-manifest classifyLivenessFreshness):
 *   - no attestation / non-string / unparseable attestedAt      ⇒ "unknown"
 *   - past OR unparseable validUntil                            ⇒ "unknown"
 *     (regardless of attestedAt — the stale-replay MUST, CONFORMANCE §2.11/§6.5)
 *   - age ≤ 60s ⇒ "live";  age ≤ 4h ⇒ "recent";  else ⇒ "stale"
 * `now` accepts an ISO string, epoch ms, or Date; defaults to the wall clock
 * (fixture evaluation ALWAYS passes the pinned evaluationContext.now).
 * The class proves recency of the ATTESTATION only — never current human presence.
 */
export function classifyLivenessFreshness(attestation, now = new Date()) {
  if (!isPlainObject(attestation)) return "unknown";
  if (typeof attestation.attestedAt !== "string") return "unknown";
  const attestedMs = Date.parse(attestation.attestedAt);
  if (!Number.isFinite(attestedMs)) return "unknown";
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(nowMs)) return "unknown"; // unusable clock ⇒ fail closed
  if (attestation.validUntil !== undefined) {
    const validUntilMs = Date.parse(attestation.validUntil);
    if (!Number.isFinite(validUntilMs) || nowMs > validUntilMs) return "unknown";
  }
  const age = nowMs - attestedMs;
  if (age <= LIVE_WINDOW_MS) return "live";
  if (age <= RECENT_WINDOW_MS) return "recent";
  return "stale";
}

/**
 * The receipt livenessStatus ECHO per EXT-T1 §T1.3: freshnessClass computed
 * from attestedAt/validUntil at the pinned now; method and userVerified copied
 * from the attestation when present (holder-asserted display echo — T1.3
 * signature-coverage note; NEVER a floor input where mechanics could attest
 * them, and NEVER a release decision). Returns undefined when the manifest
 * carries no livenessAttestation (reference-style omission).
 */
export function livenessStatusEcho(manifest, now) {
  const att = isPlainObject(manifest) ? manifest.livenessAttestation : undefined;
  if (att === undefined) return undefined;
  const echo = { freshnessClass: classifyLivenessFreshness(att, now) };
  if (isPlainObject(att)) {
    if (att.method !== undefined) echo.method = att.method;
    if (att.userVerified !== undefined) echo.userVerified = att.userVerified;
  }
  return echo;
}

// ===========================================================================
// 3) DEMO ATTESTER — the ONLY proofType this module validates (REAL Ed25519,
//    LABELED). schema.json proofValue recipe: signature over the UTF-8 bytes of
//    subject || attestedAt. Proves attestation HANDLING, not human presence.
// ===========================================================================

/**
 * Issue a demo liveness attestation (proofType "demo-ed25519"): REAL Ed25519
 * signature over UTF-8(subject || attestedAt) by the demo attester key.
 * LABEL (carried on the attestation): demo attester — proves attestation
 * handling, not human presence.
 */
export async function issueDemoLivenessAttestation({
  subject,
  attestedAt,
  validUntil,
  userVerified,
  attesterPrivateKey,
  attester,
} = {}) {
  if (!isNonEmptyString(subject)) throw new Error("issueDemoLivenessAttestation: subject required");
  if (!isIsoDateTime(attestedAt)) throw new Error("issueDemoLivenessAttestation: attestedAt must be ISO 8601");
  if (!isIsoDateTime(validUntil)) throw new Error("issueDemoLivenessAttestation: validUntil must be ISO 8601");
  const proofValue = bytesToBase64Url(await signBytes(utf8Encode(subject + attestedAt), attesterPrivateKey));
  const attestation = {
    proofType: DEMO_LIVENESS_PROOF_TYPE,
    attestedAt,
    validUntil,
    proofValue,
    method: "demo-attester",
    demoLabel: DEMO_ATTESTER_LABEL, // PREVIEW label carried on-wire (additionalProperties allowed)
  };
  if (typeof userVerified === "boolean") attestation.userVerified = userVerified;
  if (isNonEmptyString(attester)) attestation.attester = attester;
  return attestation;
}

/**
 * Verify a demo attestation's proofValue: Ed25519 over UTF-8(subject||attestedAt)
 * against the demo attester public key. Returns boolean (any throw ⇒ false).
 */
export async function verifyDemoLivenessAttestation(subject, attestation, attesterPublicKey) {
  try {
    if (!isPlainObject(attestation) || attestation.proofType !== DEMO_LIVENESS_PROOF_TYPE) return false;
    if (!isNonEmptyString(subject) || !isNonEmptyString(attestation.attestedAt)) return false;
    if (!isNonEmptyString(attestation.proofValue)) return false;
    return await verifyBytes(utf8Encode(subject + attestation.attestedAt), attestation.proofValue, attesterPublicKey);
  } catch {
    return false;
  }
}

/**
 * Determine whether the manifest's attestation counts as VALIDATED for floor
 * purposes (T1.3.1: "proof validation before freshness" — a forged-but-fresh-
 * looking attestation cannot bypass the floor):
 *   - shape-invalid                              ⇒ not validated (fail closed)
 *   - proofType "demo-ed25519" + attester key    ⇒ REAL Ed25519 verify decides
 *   - webauthn-uv / any other proofType          ⇒ NOT validated — this module
 *     implements no WebAuthn (or other) assertion mechanics; fail closed. The
 *     freshness ECHO is unaffected (an echo is not a floor decision).
 * Returns { validated: boolean, how: string }.
 */
export async function attestationValidatedForFloors(manifest, context = {}) {
  const att = isPlainObject(manifest) ? manifest.livenessAttestation : undefined;
  if (att === undefined) return { validated: false, how: "no livenessAttestation present" };
  const shape = validateLivenessAttestationShape(att);
  if (!shape.valid) return { validated: false, how: `shape invalid: ${shape.errors[0]}` };
  if (att.proofType === DEMO_LIVENESS_PROOF_TYPE) {
    if (context.demoAttesterPublicKey === undefined) {
      return { validated: false, how: "demo-ed25519 attestation but no demoAttesterPublicKey in context (fail closed)" };
    }
    const ok = await verifyDemoLivenessAttestation(manifest.subject, att, context.demoAttesterPublicKey);
    return ok
      ? { validated: true, how: `REAL Ed25519 verify over UTF-8(subject||attestedAt) — ${DEMO_ATTESTER_LABEL}` }
      : { validated: false, how: "demo-ed25519 proofValue FAILED Ed25519 verification (fail closed)" };
  }
  return {
    validated: false,
    how: `proofType "${att.proofType}" mechanics not implemented by this module — never satisfies a floor (fail closed, T1.3.1)`,
  };
}

// ===========================================================================
// 4) FLOOR CHECKS — EXT-T1 §T1.3.1 / §T1.3.3 (PREVIEW, fail closed)
// ===========================================================================

/**
 * Liveness floor comparison (T1.3.1). `floorClass` is the class usable FOR THE
 * FLOOR: the classified freshness when the attestation is validated, else
 * "unknown" (proof validation strictly before freshness). Fail-closed rules:
 * userVerified absent ≡ false; unknown is ordered lowest so NO floor value
 * (including minFreshness "stale") is met by an unknown/absent/expired root
 * attestation. Returns { met, reason }.
 */
export function livenessFloorMet(requiredLiveness, { floorClass = "unknown", attestationUserVerified } = {}) {
  const shape = validateRequiredLivenessShape(requiredLiveness);
  if (!shape.valid) return { met: false, reason: `floor shape invalid (fail closed): ${shape.errors[0]}` };
  const have = LIVENESS_FRESHNESS_RANK[floorClass] ?? 0;
  const need = LIVENESS_FRESHNESS_RANK[requiredLiveness.minFreshness];
  if (have < need) {
    return {
      met: false,
      reason: `freshness "${floorClass}" is below the requiredLiveness floor "${requiredLiveness.minFreshness}" (order live > recent > stale > unknown)`,
    };
  }
  if (requiredLiveness.userVerified === true && attestationUserVerified !== true) {
    return {
      met: false,
      reason: "floor requires userVerified: true but the attestation's userVerified is not true (absent ≡ false, fail closed)",
    };
  }
  return { met: true, reason: `validated attestation satisfies minFreshness "${requiredLiveness.minFreshness}"${requiredLiveness.userVerified === true ? " + userVerified" : ""}` };
}

/**
 * Assurance floor comparison (T1.3.3): closed ladder software < hardware-uv <
 * hardware-bound; absent floor defaults to "software" (never raises the bar);
 * a non-enum presented class falls back to "software" (unverifiable evidence
 * never raises the class — fail closed). Returns { met, assertedClass, requiredClass, reason }.
 */
export function assuranceFloorMet(requiredAssuranceClass, presentedAssuranceClass) {
  const requiredClass = isAssuranceClass(requiredAssuranceClass) ? requiredAssuranceClass : "software";
  const assertedClass = isAssuranceClass(presentedAssuranceClass) ? presentedAssuranceClass : "software";
  const met = ASSURANCE_CLASS_RANK[assertedClass] >= ASSURANCE_CLASS_RANK[requiredClass];
  return {
    met,
    assertedClass,
    requiredClass,
    reason: met
      ? `presented assurance ${assertedClass} meets requiredAssuranceClass ${requiredClass}`
      : `presented assurance ${assertedClass} is below requiredAssuranceClass ${requiredClass}`,
  };
}

// Minimal consent-gate PRECHECK — gate SEQUENCING only (Base §3.1.4: the first
// failing gate is reported in the order sealed-entry → consent → floors, so
// floors are reported only for facets whose earlier gates pass). Consent
// STATUSES are surface, never written here; when an earlier gate
// fails, this engine DEFERS (writes nothing) and the owning engine records it.
function consentGatePasses(manifest, facet, nowMs, context) {
  const consents = Array.isArray(manifest.consents) ? manifest.consents : [];
  const matching = consents.filter((c) => isPlainObject(c) && c.facetRef === facet["@id"]);
  if (matching.length === 0) return false; // consent-missing — gate
  for (const consent of matching) {
    if (consent.withdrawnAt) return false;
    if (!isIsoDateTime(consent.expiresAt) || Date.parse(consent.expiresAt) < nowMs) return false;
    if (isIsoDateTime(consent.grantedAt) && Date.parse(consent.grantedAt) > nowMs) return false;
    if (Array.isArray(consent.conditions) && consent.conditions.length > 0) return false; // unenforceable ⇒ fail-closed gate
    if (Array.isArray(context.intendedScope) && context.intendedScope.length > 0) {
      const scope = Array.isArray(consent.scope) ? consent.scope : [];
      if (!context.intendedScope.every((op) => scope.includes(op))) return false;
    }
    if (isNonEmptyString(context.intendedPurpose) && consent.purpose !== context.intendedPurpose) return false;
  }
  return true;
}

/**
 * Evaluate BOTH per-facet floors over a manifest at the pinned context
 * (Base §3.1.4 Consent-stage sequencing; PREVIEW, fail closed).
 *
 * Context inputs:
 *   now                      pinned evaluation instant (ISO) — never the wall clock in fixture mode
 *   presentedAssuranceClass  the unlock gesture's class — CALLER-determined evidence input,
 *                            defaulted FAIL-CLOSED to "software" (conformance README rule);
 *                            this module verifies no hardware provenance (T1.3.2 not implemented)
 *   demoAttesterPublicKey    enables REAL validation of demo-ed25519 attestations only
 *   enforceFloors            default true; false exercises the §2.13/§2.14 UNENFORCED
 *                            baseline — floor-bearing facets are STILL withheld (never processed)
 *   decryptableFacetIds sealed-entry gate precheck (gate order only; owns "opaque")
 *
 * Returns { fragment, floorChecks, passThroughFacetIds, deferred }:
 *   fragment plain-data receipt fragment for the hub: ONLY
 *                       floor-withheld facet statuses (status "assuranceInsufficient" —
 *                       the T1.3.3 below-floor refusal status; the closed §2.6 set has
 *                       no liveness-specific value) + the livenessStatus echo +
 *                       floorViolations diagnostics (hub captures them off-wire)
 *   floorChecks         per floor-bearing facet: what was required, what was presented,
 *                       met booleans + reasons (diagnostic surface, never on-wire)
 *   passThroughFacetIds floor-bearing facets whose gates all passed HERE (floors met);
 *                       release/processing remains the consent/projection engines' call
 *   deferred            facets whose sealed/consent gate failed — deferred to the owning
 *                       engine (this fragment writes NOTHING for them)
 */
export async function evaluateFacetFloors(manifest, context = {}) {
  const nowMs = isIsoDateTime(context.now) ? Date.parse(context.now) : Date.now();
  const enforce = context.enforceFloors !== false;
  const presented = isAssuranceClass(context.presentedAssuranceClass) ? context.presentedAssuranceClass : "software";
  const echo = livenessStatusEcho(manifest, nowMs);
  const validation = await attestationValidatedForFloors(manifest, context);
  // T1.3.1 fail-closed sequencing: proof validation strictly BEFORE freshness —
  // an unvalidated attestation is "unknown" FOR FLOOR PURPOSES regardless of
  // attestedAt (the echo above still records the classified freshness).
  const floorClass = validation.validated ? echo?.freshnessClass ?? "unknown" : "unknown";
  const attesterUv = isPlainObject(manifest?.livenessAttestation) ? manifest.livenessAttestation.userVerified : undefined;

  const fragment = { engine: "runtime-liveness-assurance", facetStatuses: [], warnings: [] };
  if (echo !== undefined) fragment.livenessStatus = echo;
  const floorChecks = [];
  const passThroughFacetIds = [];
  const deferred = [];
  const floorViolations = [];

  const facets = Array.isArray(manifest?.facets) ? manifest.facets : [];
  const decryptable = new Set(context.decryptableFacetIds ?? []);
  for (const facet of facets) {
    if (!isPlainObject(facet)) continue;
    const hasLivenessFloor = facet.requiredLiveness !== undefined;
    const hasAssuranceFloor = facet.requiredAssuranceClass !== undefined;
    if (!hasLivenessFloor && !hasAssuranceFloor) continue; // not this engine's facet
    const facetId = facet["@id"];

    // Gate order (Base §3.1.4): sealed-entry → consent → floors. Earlier-gate
    // failures are the owning engines' statuses — defer, write nothing.
    if (facet.encryptionProfile === "jwe-inline-v1" && !decryptable.has(facetId)) {
      deferred.push({ facetId, gate: "sealed-entry (runtime records opaque)" });
      continue;
    }
    if (!consentGatePasses(manifest, facet, nowMs, context)) {
      deferred.push({ facetId, gate: "consent (runtime records consent-missing/denied)" });
      continue;
    }

    // Floors gate — assurance first (T1.3.3 echo lands on the recorded status;
    // reference-evaluator order), then liveness (T1.3.1).
    const assurance = hasAssuranceFloor
      ? assuranceFloorMet(facet.requiredAssuranceClass, presented)
      : { met: true, assertedClass: presented, requiredClass: "software", reason: "no assurance floor (defaults to software — never raises the bar)" };
    const liveness = hasLivenessFloor
      ? livenessFloorMet(facet.requiredLiveness, { floorClass, attestationUserVerified: attesterUv })
      : { met: true, reason: "no liveness floor" };

    const check = {
      facetId,
      name: facet.name,
      requiredAssuranceClass: hasAssuranceFloor ? facet.requiredAssuranceClass : undefined,
      requiredLiveness: hasLivenessFloor ? facet.requiredLiveness : undefined,
      presentedAssuranceClass: presented,
      floorFreshnessClass: floorClass,
      attestationValidated: validation.validated,
      attestationValidationHow: validation.how,
      assuranceFloorMet: assurance.met,
      livenessFloorMet: liveness.met,
      enforced: enforce,
      preview: "EXT-T1 T1.3.1/T1.3.3 PREVIEW",
    };
    floorChecks.push(check);

    if (!enforce) {
      // §2.13/§2.14 UNENFORCED baseline: an evaluator that does not implement
      // floor enforcement MUST fail closed — floor-bearing facets are WITHHELD,
      // never processed.
      const entry = {
        facetId,
        ...(isNonEmptyString(facet.name) ? { name: facet.name } : {}),
        status: "assuranceInsufficient",
        reason:
          "floor enforcement not active — floor-bearing facet withheld, never processed (fail-closed baseline, CONFORMANCE §2.13/§2.14)",
      };
      if (hasAssuranceFloor) entry.assuranceStatus = { assertedClass: presented, met: false };
      fragment.facetStatuses.push(entry);
      floorViolations.push({ facetId, floor: "unenforced-baseline", reason: entry.reason });
      continue;
    }

    if (!assurance.met) {
      // T1.3.3: below floor ⇒ withhold, NEVER downgrade, record the below-floor
      // refusal status + the assuranceStatus echo (evaluator-asserted class).
      fragment.facetStatuses.push({
        facetId,
        ...(isNonEmptyString(facet.name) ? { name: facet.name } : {}),
        status: "assuranceInsufficient",
        reason: `${assurance.reason} — facet withheld, never downgraded (EXT-T1 T1.3.3 PREVIEW)`,
        assuranceStatus: { assertedClass: assurance.assertedClass, met: false },
      });
      floorViolations.push({ facetId, floor: "requiredAssuranceClass", reason: assurance.reason });
      continue;
    }
    if (!liveness.met) {
      // T1.3.1: floor unmet ⇒ withhold (fail closed). Recorded with the
      // below-floor refusal status "assuranceInsufficient" — the closed §2.6
      // status set defines no liveness-specific value and T1.3.3 names
      // assuranceInsufficient THE below-floor refusal status (mapping decision;
      // no fixture pins the liveness-only case). No assuranceStatus echo here:
      // the echo object is the ASSURANCE-class record (Base §3.3.1.1) and this
      // facet's assurance floor (if any) was met.
      fragment.facetStatuses.push({
        facetId,
        ...(isNonEmptyString(facet.name) ? { name: facet.name } : {}),
        status: "assuranceInsufficient",
        reason: `requiredLiveness floor unmet: ${liveness.reason} — facet withheld (EXT-T1 T1.3.1 PREVIEW, fail closed)`,
      });
      floorViolations.push({ facetId, floor: "requiredLiveness", reason: liveness.reason });
      continue;
    }
    passThroughFacetIds.push(facetId);
  }

  if (floorViolations.length > 0) fragment.floorViolations = floorViolations; // hub diagnostics (off-wire)
  return { fragment, floorChecks, passThroughFacetIds, deferred };
}

/**
 * The composition surface: this engine's receipt fragment as PLAIN DATA
 * for receipt-hub mergeFragment (recommended merge order: tier(133) →
 * assurance(135) → sealed(132) → consent(122) → projection(123)). Writes ONLY
 * what this engine owns: the livenessStatus echo + floor-withheld facet
 * statuses (+ off-wire floorViolations diagnostics). Floor-met facets get NO
 * entry — release is the consent/projection engines' call.
 */
export async function buildWo135Fragment(manifest, context = {}) {
  return (await evaluateFacetFloors(manifest, context)).fragment;
}

// ===========================================================================
// 5) EVALUATION verdict — the T1.3 slice at the pinned evaluationContext,
//    composed THROUGH the hub (createReceipt → mergeFragment →
//    finalizeReceipt; the hub's shape contract fails closed).
// ===========================================================================

/**
 * Evaluate ONE manifest through this change's slice at the pinned context:
 *   Arrive/Verify structural+signature → freshness (60s skew) →
 *   livenessStatus echo (T1.3) → per-facet floors (T1.3.1/T1.3.3, Consent-stage
 *   sequencing) → hub composition (composeOutcome rule 1 makes an
 *   assuranceInsufficient-with-nothing-processed receipt "rejected").
 * Returns { result: "accept"|"reject", receipt }. Facets that pass every gate
 * this slice can check are recorded "processed" ONLY in this STANDALONE mode
 * (consent precheck passed + floors met); composition use
 * buildWo135Fragment instead and leave release to the owning engines.
 */
export async function evaluateWo135(manifest, context = {}) {
  const nowMs = isIsoDateTime(context.now) ? Date.parse(context.now) : Date.now();
  const manifestId = isPlainObject(manifest) && isNonEmptyString(manifest["@id"]) ? manifest["@id"] : "(unknown)";
  const receipt = createReceipt({ manifestId, evaluatorId: context.evaluatorId });
  let hardReject = false;

  // --- Arrive/Verify: envelope + shapes ------------------------------
  const envErrors = envelopeErrors(manifest);
  const shapeErrors = envErrors.length === 0 ? validateWo135Structural(manifest).errors : [];
  if (envErrors.length > 0 || shapeErrors.length > 0) {
    mergeFragment(receipt, {
      engine: "runtime-liveness-assurance",
      outcome: "rejected",
      warnings: [{ code: "um:reason:structure:malformed", message: `Verify stage: ${[...envErrors, ...shapeErrors].join("; ")}` }],
    });
    hardReject = true;
  }

  // --- Signature (real Ed25519 Profile A) -----------------------------------
  if (!hardReject) {
    const sigReport = await verifyManifestProfileA(manifest);
    if (!sigReport.ok) {
      const unsupported = sigReport.reason === "unsupported-profile";
      mergeFragment(receipt, {
        engine: "runtime-liveness-assurance",
        outcome: "rejected",
        signatureCheck: unsupported ? "unsupported-profile" : sigReport.reason === "missing-signature" ? "missing" : "invalid",
        warnings: [
          {
            code: unsupported ? "um:reason:crypto:unsupported-profile" : "um:reason:crypto:signature-invalid",
            message: `Verify stage: ${sigReport.reason}`,
          },
        ],
      });
      hardReject = true;
    } else {
      mergeFragment(receipt, { engine: "runtime-liveness-assurance", signatureCheck: "valid" });
    }
  }

  // --- Freshness at the PINNED now (Section 3.1.2; 60s skew) ----------------
  if (!hardReject) {
    const SKEW_MS = 60_000;
    if (Date.parse(manifest.issuedAt) - nowMs > SKEW_MS) {
      mergeFragment(receipt, {
        engine: "runtime-liveness-assurance",
        outcome: "rejected",
        freshnessCheck: "stale",
        warnings: [{ code: "um:reason:freshness:stale", message: "Verify stage: issuedAt more than 60s in the future" }],
      });
      hardReject = true;
    } else if (nowMs > Date.parse(manifest.expiresAt)) {
      mergeFragment(receipt, {
        engine: "runtime-liveness-assurance",
        outcome: "rejected",
        freshnessCheck: "expired",
        warnings: [{ code: "um:reason:freshness:expired", message: "Verify stage: manifest expired" }],
      });
      hardReject = true;
    } else {
      mergeFragment(receipt, { engine: "runtime-liveness-assurance", freshnessCheck: "fresh" });
    }
  }

  // --- T1.3 echo + T1.3.1/T1.3.3 floors (the slice this change owns) ------------
  let floors = { fragment: { engine: "runtime-liveness-assurance" }, floorChecks: [], passThroughFacetIds: [], deferred: [] };
  if (!hardReject) {
    floors = await evaluateFacetFloors(manifest, { ...context, now: new Date(nowMs).toISOString() });
    mergeFragment(receipt, floors.fragment);
    // STANDALONE mode only: gates this slice can check all passed ⇒ "processed"
    // (receipt semantics: released under valid consent; nothing is decrypted or
    // read here). Under composition the owning engines write these.
    for (const facetId of floors.passThroughFacetIds) {
      const facet = (manifest.facets || []).find((f) => isPlainObject(f) && f["@id"] === facetId);
      mergeFragment(receipt, {
        engine: "runtime-liveness-assurance",
        facetStatuses: [{ facetId, ...(facet && isNonEmptyString(facet.name) ? { name: facet.name } : {}), status: "processed" }],
      });
    }
  }

  const finalized = finalizeReceipt(receipt, {
    rejected: hardReject,
    now: isIsoDateTime(context.now) ? context.now : undefined,
    omitProcessedAt: context.omitProcessedAt === true,
  });
  return {
    result: finalized.outcome === "rejected" ? "reject" : "accept",
    receipt: finalized,
    floorChecks: floors.floorChecks,
    deferred: floors.deferred,
  };
}

// ===========================================================================
// 6) DEMO SURFACE — the "locked facet" scenario (fixture-derived; the page's
//    hospital-corridor scene was CUT by scenario — this is NOT a page
//    scene). Pure functions; UI wiring into live-adapter.js is the
//    a serialized edit.
// ===========================================================================

export const feature_DEMO_SCENARIO_LABEL =
  "fixture-derived: valid/manifest-locked-facet-below-floor.jsonld (locked-tier portable-unlock profile) — conformance-surface demo, NOT a page scene (runtime scenario)";

/**
 * Build + evaluate the locked-facet demo end-to-end with FRESH keys (the
 * manifest signature and the demo attestation are REAL crypto; the presented
 * assurance class is a SIMULATED unlock toggle, labeled — no hardware
 * provenance is verified, T1.3.2 not implemented):
 *   1. subject signs a manifest carrying the fixture-derived locked facet
 *      (requiredAssuranceClass "hardware-bound" + requiredLiveness
 *      {live, userVerified:true}) and an in-window unlock consent
 *   2. LOCKED pass: presented class "software" (the fail-closed default) ⇒
 *      facet visibly WITHHELD — status "assuranceInsufficient",
 *      assuranceStatus {assertedClass:"software", met:false}, outcome rejected
 *   3. UNLOCK pass (demoUnlock:true): presented class "hardware-bound"
 *      (SIMULATED toggle) + a validated demo attestation (REAL Ed25519,
 *      freshnessClass "live", userVerified:true) ⇒ floors met, facet released
 * Returns { label, manifest, lockedReceipt, lockedPanelRow, unlockedReceipt?,
 *           unlockedPanelRow?, floorChecksLocked, floorChecksUnlocked?, honesty }.
 */
export async function demoLockedFacetScenario({ demoUnlock = false, now } = {}) {
  const subjectKeys = await generateKeyPair();
  const attesterKeys = await generateKeyPair();
  const nowIso = isIsoDateTime(now) ? now : new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const subject = "did:web:demo.local:user:runtime";
  const facetId = "urn:um:facet:runtime-locked-demo";

  const attestation = await issueDemoLivenessAttestation({
    subject,
    attestedAt: new Date(nowMs - 5_000).toISOString(), // 5s ago ⇒ "live"
    validUntil: new Date(nowMs + 3600_000).toISOString(),
    userVerified: true,
    attesterPrivateKey: attesterKeys.privateKey,
    attester: "did:web:demo.local:attester:runtime",
  });

  const draft = {
    "@context": "https://universalmanifest.net/ns/v0.4",
    "@id": `urn:uuid:${globalThis.crypto.randomUUID()}`,
    "@type": "um:Manifest",
    manifestVersion: "0.4",
    subject,
    issuedAt: nowIso,
    expiresAt: new Date(nowMs + 3600_000).toISOString(),
    livenessAttestation: attestation,
    facets: [
      {
        "@id": facetId,
        "@type": "um:Facet",
        name: "lockedDemoFacet",
        requiredLiveness: { minFreshness: "live", userVerified: true },
        requiredAssuranceClass: "hardware-bound",
      },
    ],
    consents: [
      {
        "@id": "urn:um:consent:runtime-unlock-window",
        "@type": "um:Consent",
        facetRef: facetId,
        scope: ["read", "unlock.window"],
        purpose: "runtime locked-facet conformance-surface demo (fixture-derived)",
        grantedAt: nowIso,
        expiresAt: new Date(nowMs + 300_000).toISOString(),
        unlockWindowFacets: [facetId],
      },
    ],
  };
  const manifest = await attachSignatureProfileA(draft, subjectKeys.seed);

  // LOCKED pass — presented class defaults fail-closed to "software".
  const locked = await evaluateWo135(manifest, {
    now: nowIso,
    presentedAssuranceClass: "software",
    demoAttesterPublicKey: attesterKeys.rawPublicKey,
    evaluatorId: "did:web:demo.local:world:runtime-demo",
  });

  const out = {
    label: feature_DEMO_SCENARIO_LABEL,
    manifest,
    lockedReceipt: locked.receipt,
    lockedPanelRow: receiptPanelRecord(locked.receipt, { label: "locked facet — below floor (withheld)" }),
    floorChecksLocked: locked.floorChecks,
    honesty:
      `manifest signature + demo attestation are REAL Ed25519; ${DEMO_ATTESTER_LABEL}; ` +
      'the presented assurance class is a SIMULATED unlock toggle (no hardware provenance verified — T1.3.2 not implemented); ' +
      "floors are EXT-T1 T1.3.1/T1.3.3 PREVIEW and fail closed",
  };

  if (demoUnlock) {
    const unlocked = await evaluateWo135(manifest, {
      now: nowIso,
      presentedAssuranceClass: "hardware-bound", // SIMULATED demo toggle — labeled, never a provenance claim
      demoAttesterPublicKey: attesterKeys.rawPublicKey,
      evaluatorId: "did:web:demo.local:world:runtime-demo",
    });
    out.unlockedReceipt = unlocked.receipt;
    out.unlockedPanelRow = receiptPanelRecord(unlocked.receipt, { label: "locked facet — demo unlock (simulated class toggle)" });
    out.floorChecksUnlocked = unlocked.floorChecks;
  }
  return out;
}

// ===========================================================================
// 7) FIXTURE HANDLER + REGISTRATION HOOK (the composed v0.4 runner wires this
//    with ONE line — applied by the integration step, not by this module).
// ===========================================================================

/** The 12 fixture files owns. */
export const feature_FIXTURE_FILENAMES = Object.freeze([
  "valid/manifest-with-liveness-attestation.jsonld",
  "valid/liveness-attestation-past-valid-until.jsonld",
  "invalid/liveness-missing-valid-until.jsonld",
  "valid/facet-required-liveness.jsonld",
  "invalid/required-liveness-bad-minfreshness.jsonld",
  "invalid/required-liveness-not-object.jsonld",
  "valid/facet-required-assurance-class.jsonld",
  "valid/facet-assurance-hardware-uv.jsonld",
  "valid/facet-assurance-software.jsonld",
  "valid/manifest-locked-facet-below-floor.jsonld",
  "invalid/facet-assurance-class-bad-enum-shape.jsonld",
  "invalid/facet-assurance-class-not-string-shape.jsonld",
]);

/**
 * Evaluate ONE fixture against its expected.json entry contract:
 *   entry.validationMode "evaluation" ⇒ evaluateWo135 under entry.evaluationContext
 *   otherwise                         ⇒ structuralVerdictWo135 (clock-independent)
 * Returns { result: "accept"|"reject", reason, receipt? } — the adapter shape
 * the runner pattern uses, so a composed v0.4 runner can dispatch
 * fixtures to this handler with no impedance mismatch.
 */
export async function featureFixtureHandler(fixtureJson, expectedEntry = {}) {
  if (expectedEntry.validationMode === "evaluation") {
    const { result, receipt } = await evaluateWo135(fixtureJson, expectedEntry.evaluationContext || {});
    return { result, reason: receipt.warnings?.[0]?.message || receipt.outcome, receipt };
  }
  const verdict = await structuralVerdictWo135(fixtureJson);
  return { result: verdict.result, reason: verdict.reasons.join("; ") || "structural contract satisfied" };
}

/**
 * Registration hook for a composed v0.4 conformance runner. Contract:
 *   registry.register(filename, asyncHandler(fixtureJson, expectedEntry))
 * The orchestrator wires it with exactly:
 *   import { registerWo135 } from "../manifest/liveness-assurance.mjs";
 *   registerWo135(registry);
 */
export function registerWo135(registry) {
  if (!registry || typeof registry.register !== "function") {
    throw new Error("registerWo135: registry with a register(filename, handler) function required");
  }
  for (const filename of feature_FIXTURE_FILENAMES) {
    registry.register(filename, featureFixtureHandler);
  }
  return feature_FIXTURE_FILENAMES.length;
}

// END
