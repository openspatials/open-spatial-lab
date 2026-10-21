// Universal Manifest v0.4 Tier-2 ZKP binding proofs +
// cross-DID binding + Tier-3 ceremony proofs — STRUCTURAL + FAIL-CLOSED
// (EXT-T2 / EXT-T3 PREVIEW).
//
// ---------------------------------------------------------------------------
// HONESTY CEILING (the strictest honesty case in the program — read first)
// ---------------------------------------------------------------------------
// This module performs STRUCTURAL SHAPE VALIDATION per EXT-T2/EXT-T3 (PREVIEW);
// NO zero-knowledge verification is performed or claimed. There is NO BBS+
// verifier, NO Groth16 verifier, NO FROST/threshold-BBS aggregate verifier
// here — and none is claimed anywhere in this module's outputs.
//
//   - A structurally-well-formed zk envelope that cannot be cryptographically
//     verified is accepted STRUCTURALLY ONLY, as PREVIEW, and NEVER elevates
//     trust: no code path in this module records a proof "verified", sets
//     crossDidBindingStatus "verified", or contributes any tier above 0.
//     (verify.mjs proves this behaviorally AND by scanning this source.)
//   - Every zk-proof / Tier-3-ceremony DISPOSITION fails closed:
//     a Tier-2/3 requirement on this evaluator records `trustTierUnsupported`
//     at the capability boundary (never downgraded, never reported verified) —
//     spec/v0.4/CONFORMANCE.md §2.15; Base §6.4.5; EXT-T3 §T3.4 last rule.
//   - The cross-DID binding STRUCTURAL checks are REAL where implementable
//     (boundDids cardinality, attester-triple rule, per-type required proof
//     fields, M-of-N quorum counting, distinct-attester counting); everything
//     that would require cryptography fails closed.
//   - This module flips NO um_conformance flag and does not touch the P5
//     portaling age-proof boundary (issuer-asserted signed VC is NOT
//     relabeled as ZK).
//
// ---------------------------------------------------------------------------
// What this module owns
// ---------------------------------------------------------------------------
//   valid/manifest-with-zkp-binding-proof.jsonld      accept  (tier2-zkp)
//   valid/cross-did-binding-proof-only.jsonld         accept  (tier2-zkp; the
//         attester triple is REQUIRED only for attester-asserted bindings —
//         Base §6.4.4 / $defs.crossDidBindingClaim allOf)
//   valid/manifest-with-ceremony-proof.jsonld         accept  (tier3-ceremony;
//         TRANSITIONAL: predates the `protocol` member, REQUIRED only at wire
//         freeze — EXT-T3 §T3.1)
//   invalid/binding-proof-invalid-type.jsonld         reject  (schema-detectable)
//   invalid/ceremony-proof-insufficient-attesters.jsonld  reject (EVALUATOR-ONLY:
//         attesters count < threshold M — not JSON-Schema-expressible)
//
// Structural semantics are pinned to the reference implementation that produced
// conformance/v0.4/expected.json:
// packages/universal-manifest/src/index.ts — assertBindingProofV04 (~L2214),
// assertCeremonyProofV04 (~L2262), the v0.4 crossDidBinding claim rules
// (~L2415), and the evaluator's "recognized claims record `unverified` rather
// than `verified`" posture (~L3176). Error strings mirror the reference's
// diagnostics so the fixtures' `__expectedError` substrings match verbatim.
//
// Profile prose additionally enforced (normative prose until wire freeze,
// EXT-T3 §T3.1 wire note; strictly MORE fail-closed than the schema, exercised
// by no fixture so reference parity is preserved):
//   - threshold M ≤ N ("5-of-3" is malformed);
//   - attesters at most N entries;
//   - DISTINCT attesters counted toward the quorum (a duplicated DID MUST NOT
//     be counted — the quorum check runs on the distinct count).
// And EXT-T2 §T2.1 cardinality (prose): a bindingProof on a claim whose
// boundDids cardinality is not exactly 2 is treated as a proof that FAILS
// verification (recorded failed, Tier-0 cap) — never a sub-pair selection.
// NOTE this cardinality rule is a VERIFICATION-failure disposition, not a
// structural manifest reject (the published schema constrains only minItems 2),
// so it lives in the disposition layer below, not in the structural verdict.
//
// DEPENDENCIES: tier engine (the fail-closed capability/cap math this
// module records dispositions through) and Profile A verifier (the
// REAL envelope-signature check in the structural verdict). The receipt field
// `crossDidBindingStatus` written here is the slot hub reserved for
// written INTO the
// hub's shape, never forked.
//
// Zero non-local dependencies; plain ESM (.mjs) — imports cleanly in Node and
// the browser, like the sibling modules.

import {
  evaluateTrustTiers,
  effectiveFloor,
  defaultHolderBindingStatusOf,
  DEFAULT_MAX_SUPPORTED_TRUST_TIER,
  BINDING_VERIFIED,
  BINDING_FAILED,
  BINDING_ABSENT,
  BINDING_PRESENT_UNVERIFIED,
} from "./trust-tier.mjs";
import { verifyManifestProfileA } from "../signing/um-signature-profile-a.mjs";

// ===========================================================================
// Vocabulary (schema.json $defs.bindingProof / $defs.ceremonyProof)
// ===========================================================================

/** The two defined Tier-2 ZKP proof profiles (EXT-T2 §T2.1.1 / §T2.1.2). */
export const BINDING_PROOF_TYPES = Object.freeze(["ZkLinkedSecretProof", "ZkHdDerivationProof"]);

/** The single defined Tier-3 ceremony proof type (EXT-T3 §T3.1). */
export const CEREMONY_PROOF_TYPE = "ThresholdAttestationProof";

/** Candidate `protocol` tokens (EXT-T3 §T3.1 — design-stage; REQUIRED only at
 *  wire freeze; the published fixture suite predates the member entirely). */
export const CEREMONY_PROTOCOL_CANDIDATES = Object.freeze(["frost-ed25519", "threshold-bbs"]);

/** Recognized attester-role tokens (EXT-T3 §T3.2 taxonomy — candidate member). */
export const ATTESTER_ROLES = Object.freeze(["subject", "witness", "custodian", "auditor"]);

/**
 * crossDidBindingStatus vocabulary — the receipt-hub slot this module
 * writes (merge rule set-if-absent; failure-dominant roll-up below mirrors the
 * hub's holderBindingStatus discipline). "verified" is listed for vocabulary
 * completeness for a FUTURE real Tier-2/3 verifier: THIS module has no code
 * path that emits it (proven by verify.mjs, behaviorally + source scan).
 */
export const CROSS_DID_BINDING_STATUSES = Object.freeze([
  BINDING_VERIFIED, // "verified"  — UNREACHABLE from this module (honesty ceiling)
  BINDING_FAILED, // "failed"    — structural malformation / EXT-T2 cardinality violation
  BINDING_PRESENT_UNVERIFIED, // "present-unverified" — shape-valid, NO crypto performed (PREVIEW)
  BINDING_ABSENT, // "absent"    — no cross-DID binding material on the manifest
]);
const CDB_DOMINANCE = { [BINDING_FAILED]: 3, [BINDING_PRESENT_UNVERIFIED]: 2, [BINDING_VERIFIED]: 1, [BINDING_ABSENT]: 0 };

/** Warning codes — reused from the hub registry (never invented here). */
export const WARN_STRUCTURE_MALFORMED = "um:reason:structure:malformed";
export const WARN_BINDING_FAILED = "um:reason:trust:binding-failed";

/** The mandatory PREVIEW label (task acceptance wording — quoted by every surface). */
export const feature_PREVIEW_LABEL =
  "structural shape validation per EXT-T2/EXT-T3 (PREVIEW); no zero-knowledge verification performed or claimed";

/** The ceremony fixture's transitional-protocol note (task acceptance echo). */
export const feature_PROTOCOL_TRANSITIONAL_NOTE =
  "transitional: ceremonyProof predates the `protocol` member, which is REQUIRED only at wire freeze " +
  "(EXT-T3 §T3.1); without it the aggregateProof is evaluable only with out-of-band protocol knowledge " +
  "and is otherwise recorded trustTierUnsupported (EXT-T3 §T3.4 step 3)";

// Machine-readable scoped-claim descriptor (house pattern: feature_CONFORMANCE /
// TRUST_TIER_ENGINE). Every boolean is backed by verify.mjs output.
export const feature_CONFORMANCE = Object.freeze({
  wo: "runtime",
  standard:
    "Universal Manifest v0.4 Base §6.4.4/§6.4.7/§6.4.8 + EXT-T2 §T2.1 + EXT-T3 §T3.1–T3.4 (both profiles PREVIEW)",
  fixtures_owned: 5,
  // REAL (structural / fail-closed logic, no crypto claimed):
  binding_proof_shape_validation_real: true, // both types, per-type required fields ($defs.bindingProof parity)
  ceremony_proof_shape_validation_real: true, // M-of-N parse + quorum count (evaluator-only) + prose M≤N/≤N/distinct
  cross_did_binding_claim_rules_real: true, // boundDids ≥2; attester triple required only when no proof carries the binding
  ext_t2_pairwise_cardinality_check_real: true, // bindingProof + boundDids ≠ 2 ⇒ proof FAILS (Tier-0 cap), never sub-pair
  fail_closed_disposition_real: true, // composition: trustTierUnsupported at the capability boundary, never downgraded
  envelope_signature_check_real: true, // Profile A Ed25519 in the structural verdict (fixtures carry genuine signatures)
  // NOT IMPLEMENTED — PREVIEW, fail closed, NEVER reported verified:
  zk_linked_secret_verification: false, // no BBS+ / BLS12-381 pairing crypto (EXT-T2 §T2.1.1)
  zk_hd_derivation_verification: false, // no Groth16/PLONK verifier, no circuit resolution (EXT-T2 §T2.1.2)
  credential_subject_binding_check: false, // T2.1.3 step-2 credential resolution not performed
  did_document_key_binding_check: false, // T2.1.3 step-3 DID-document verification-method check not performed
  threshold_ceremony_verification: false, // no FROST / threshold-BBS aggregateProof verification (EXT-T3 §T3.3/T3.4 step 5)
  attester_trust_list_check: false, // T3.4 step-6 trust-list policy not implemented
  tier2_or_tier3_ever_reported_verified: false, // THE honesty ceiling — proven by verify.mjs
  um_conformance_flag_flipped: false,
  preview_label: feature_PREVIEW_LABEL,
  scoped_claim:
    "runtime implements REAL structural shape validation for bindingProof (ZkLinkedSecretProof / " +
    "ZkHdDerivationProof), ceremonyProof (ThresholdAttestationProof, incl. the evaluator-only " +
    "attesters≥M quorum count), and identity.crossDidBinding claims, plus the REAL fail-closed " +
    "disposition through the runtime tier engine. " +
    feature_PREVIEW_LABEL +
    ". A well-formed validation is at best 'present-unverified' and never elevates trust.",
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
function refOf(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  if (isNonEmptyString(o["@id"])) return o["@id"];
  return typeof o["@type"] === "string" ? o["@type"] : "";
}
function claimsOf(manifest) {
  return Array.isArray(manifest?.claims) ? manifest.claims.filter((c) => c && typeof c === "object") : [];
}

// ===========================================================================
// 1) STRUCTURAL SURFACE — shape validation (schema.json $defs parity + the
//    reference implementation's evaluator-only checks + EXT-T3 prose rules)
// ===========================================================================

/**
 * Validate a bindingProof per schema.json $defs.bindingProof (EXT-T2 §T2.1):
 * type enum + per-type REQUIRED fields. Error strings mirror the reference
 * implementation's assertBindingProofV04 diagnostics (the invalid-type message
 * carries the fixture's `__expectedError` substring verbatim).
 *
 * Every check here is SCHEMA-DETECTABLE (the published JSON Schema's enum +
 * allOf/if-then expresses all of it) — CONFORMANCE §5.3 classification.
 * Returns { valid, errors } (all errors schema-detectable).
 */
export function validateBindingProofShape(validation) {
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) {
    return { valid: false, errors: ["bindingProof must be an object"] };
  }
  const errors = [];
  if (validation.type === "ZkLinkedSecretProof") {
    // Profile 2A (EXT-T2 §T2.1.1). The profile prose pins cryptosuite
    // "bbs-2023" / proofPurpose "authentication"; the published schema (and the
    // reference assert) requires PRESENCE, not those exact values — value
    // conformance is a verification-profile concern (PREVIEW), noted only.
    if (!isNonEmptyString(validation.cryptosuite)) errors.push("ZkLinkedSecretProof: missing cryptosuite");
    if (!isNonEmptyString(validation.proofPurpose)) errors.push("ZkLinkedSecretProof: missing proofPurpose");
    if (!isNonEmptyString(validation.proofValue)) errors.push("ZkLinkedSecretProof: missing proofValue");
    if (!validation.publicInputs || typeof validation.publicInputs !== "object" || Array.isArray(validation.publicInputs)) {
      errors.push("ZkLinkedSecretProof: missing publicInputs");
    } else if (
      typeof validation.publicInputs.commitmentA !== "string" ||
      typeof validation.publicInputs.commitmentB !== "string"
    ) {
      errors.push("ZkLinkedSecretProof: publicInputs must contain commitmentA and commitmentB");
    }
  } else if (validation.type === "ZkHdDerivationProof") {
    // Profile 2B (EXT-T2 §T2.1.2).
    if (!isNonEmptyString(validation.proofSystem)) errors.push("ZkHdDerivationProof: missing proofSystem");
    if (!isNonEmptyString(validation.circuit)) errors.push("ZkHdDerivationProof: missing circuit");
    if (!isNonEmptyString(validation.proofValue)) errors.push("ZkHdDerivationProof: missing proofValue");
    if (!validation.publicInputs || typeof validation.publicInputs !== "object" || Array.isArray(validation.publicInputs)) {
      errors.push("ZkHdDerivationProof: missing publicInputs");
    } else {
      const pi = validation.publicInputs;
      if (typeof pi.publicKeyA !== "string" || typeof pi.publicKeyB !== "string") {
        errors.push("ZkHdDerivationProof: publicInputs must contain publicKeyA and publicKeyB");
      }
      if (typeof pi.derivationPathA !== "string" || typeof pi.derivationPathB !== "string") {
        errors.push("ZkHdDerivationProof: publicInputs must contain derivationPathA and derivationPathB");
      }
    }
  } else {
    // The fixture invalid/binding-proof-invalid-type.jsonld pins this message's
    // leading substring as its __expectedError.
    errors.push(`bindingProof.type must be ZkLinkedSecretProof or ZkHdDerivationProof, got ${String(validation.type)}`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a ceremonyProof per schema.json $defs.ceremonyProof + EXT-T3 §T3.1.
 * Two error layers per CONFORMANCE §5.3 (the reason expected.json classifies
 * invalid/ceremony-proof-insufficient-attesters.jsonld `evaluator-only`):
 *
 *   schemaDetectableErrors — type const, threshold pattern ^\d+-of-\d+$,
 *       attesters non-empty array of non-empty strings, ceremonyId,
 *       aggregateProof (all expressible in the published JSON Schema).
 *   evaluatorOnlyErrors — the quorum COUNT (attesters ≥ M, mirroring the
 *       reference's assertCeremonyProofV04 with its exact message — the
 *       fixture's __expectedError substring) + the EXT-T3 §T3.1 prose rules
 *       (M ≤ N; at most N entries; DISTINCT entries counted toward the
 *       quorum). Counting against a parsed threshold is not JSON-Schema-
 *       expressible ("the published threshold pattern alone admits 5-of-3").
 *
 * Also surfaces the TRANSITIONAL `protocol` posture (EXT-T3 §T3.1): absent is
 * NOT a malformation before wire freeze — `protocolNote` echoes the rule.
 * Returns { valid, errors, schemaDetectableErrors, evaluatorOnlyErrors,
 *           threshold: {m,n}|null, protocol: string|null, protocolNote,
 *           attesterRolesNote? }.
 */
export function validateCeremonyProofShape(validation) {
  const schemaDetectableErrors = [];
  const evaluatorOnlyErrors = [];
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) {
    return {
      valid: false,
      errors: ["ceremonyProof must be an object"],
      schemaDetectableErrors: ["ceremonyProof must be an object"],
      evaluatorOnlyErrors: [],
      threshold: null,
      protocol: null,
      protocolNote: null,
    };
  }
  if (validation.type !== CEREMONY_PROOF_TYPE) {
    schemaDetectableErrors.push("ceremonyProof.type must be ThresholdAttestationProof");
  }
  let threshold = null;
  if (typeof validation.threshold !== "string" || !/^\d+-of-\d+$/.test(validation.threshold)) {
    schemaDetectableErrors.push("ceremonyProof.threshold must be in M-of-N format");
  } else {
    const [m, n] = validation.threshold.split("-of-").map((x) => parseInt(x, 10));
    threshold = { m, n };
  }
  const attestersIsArray = Array.isArray(validation.attesters);
  if (!attestersIsArray || validation.attesters.length === 0) {
    schemaDetectableErrors.push("ceremonyProof.attesters must be a non-empty array");
  } else {
    for (const a of validation.attesters) {
      if (!isNonEmptyString(a)) {
        schemaDetectableErrors.push("ceremonyProof.attesters entries must be non-empty strings");
        break;
      }
    }
  }
  if (!isNonEmptyString(validation.ceremonyId)) schemaDetectableErrors.push("ceremonyProof: missing ceremonyId");
  if (!isNonEmptyString(validation.aggregateProof)) schemaDetectableErrors.push("ceremonyProof: missing aggregateProof");

  // ---- EVALUATOR-ONLY layer (reference assert + EXT-T3 §T3.1 prose) --------
  if (threshold && attestersIsArray && validation.attesters.length > 0) {
    const { m, n } = threshold;
    // Reference parity FIRST (fixture __expectedError: "ceremonyProof.attesters
    // must have at least"): raw count ≥ M, exact reference message shape.
    if (validation.attesters.length < m) {
      evaluatorOnlyErrors.push(
        `ceremonyProof.attesters must have at least ${m} entries (threshold: ${validation.threshold})`
      );
    }
    // EXT-T3 §T3.1 prose (normative until wire freeze; no fixture exercises
    // these — strictly MORE fail-closed than the reference assert):
    if (m < 1 || n < 1 || m > n) {
      evaluatorOnlyErrors.push(
        `ceremonyProof.threshold "${validation.threshold}" is malformed: M and N must be positive integers with M <= N (EXT-T3 Section T3.1)`
      );
    }
    if (m <= n && validation.attesters.length > n) {
      evaluatorOnlyErrors.push(
        `ceremonyProof.attesters must have at most ${n} entries (threshold: ${validation.threshold}, EXT-T3 Section T3.1)`
      );
    }
    const distinct = new Set(validation.attesters.filter(isNonEmptyString));
    if (distinct.size < validation.attesters.length && distinct.size < m) {
      // A duplicated DID MUST NOT be counted toward the quorum (EXT-T3 §T3.1):
      // the quorum check runs on the DISTINCT count.
      evaluatorOnlyErrors.push(
        `ceremonyProof.attesters must contain at least ${m} DISTINCT entries — duplicated DIDs do not count toward the quorum (${distinct.size} distinct of ${validation.attesters.length}; EXT-T3 Section T3.1)`
      );
    }
  }

  // ---- transitional `protocol` + candidate attesterRoles (never rejecting) --
  const protocol = isNonEmptyString(validation.protocol) ? validation.protocol : null;
  const protocolNote = protocol === null ? feature_PROTOCOL_TRANSITIONAL_NOTE : null;
  let attesterRolesNote;
  if (validation.attesterRoles !== undefined) {
    // EXT-T3 §T3.2: a malformed attesterRoles map is treated as ABSENT (roles
    // undeclared) — a normalization, not a rejection.
    const rolesOk =
      validation.attesterRoles &&
      typeof validation.attesterRoles === "object" &&
      !Array.isArray(validation.attesterRoles) &&
      attestersIsArray &&
      Object.keys(validation.attesterRoles).every((did) => validation.attesters.includes(did));
    attesterRolesNote = rolesOk
      ? "attesterRoles declared (candidate member, EXT-T3 Section T3.2); role constraints are profile-defined and NOT evaluated here"
      : "attesterRoles malformed (key not a member of attesters, or not a map) — treated as ABSENT per EXT-T3 Section T3.2 (roles undeclared)";
  }

  const errors = [...schemaDetectableErrors, ...evaluatorOnlyErrors];
  return {
    valid: errors.length === 0,
    errors,
    schemaDetectableErrors,
    evaluatorOnlyErrors,
    threshold,
    protocol,
    protocolNote,
    ...(attesterRolesNote !== undefined ? { attesterRolesNote } : {}),
  };
}

/**
 * Validate an identity.crossDidBinding claim per schema.json
 * $defs.crossDidBindingClaim (Base §6.4.4):
 *   - issuer + boundDids (array of ≥ 2 non-empty strings) REQUIRED;
 *   - the attester triple (attester, attestationMethod, attestedAt) REQUIRED
 *     ONLY when NO cryptographic bindingProof/ceremonyProof carries the
 *     binding (the fixture valid/cross-did-binding-proof-only.jsonld pins the
 *     proof-only path);
 *   - nested bindingProof/ceremonyProof shapes validated when present.
 * All checks in THIS function are schema-detectable; nested ceremonyProof
 * quorum counting contributes its own evaluator-only layer (split preserved
 * in the returned { schemaDetectableErrors, evaluatorOnlyErrors }).
 */
export function validateCrossDidBindingClaimShape(claim) {
  const schemaDetectableErrors = [];
  const evaluatorOnlyErrors = [];
  const notes = [];
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    return {
      valid: false,
      errors: ["identity.crossDidBinding claim must be an object"],
      schemaDetectableErrors: ["identity.crossDidBinding claim must be an object"],
      evaluatorOnlyErrors: [],
      notes,
    };
  }
  if (!isNonEmptyString(claim.issuer)) {
    schemaDetectableErrors.push("identity.crossDidBinding claim missing issuer");
  }
  if (!Array.isArray(claim.boundDids) || claim.boundDids.length < 2) {
    schemaDetectableErrors.push("identity.crossDidBinding claim must contain at least 2 boundDids");
  } else if (!claim.boundDids.every(isNonEmptyString)) {
    schemaDetectableErrors.push("identity.crossDidBinding boundDids entries must be non-empty strings");
  }
  const carriesCryptographicBinding = claim.bindingProof !== undefined || claim.ceremonyProof !== undefined;
  if (!carriesCryptographicBinding) {
    if (!isNonEmptyString(claim.attester)) {
      schemaDetectableErrors.push(
        "identity.crossDidBinding claim missing attester (required for attester-asserted bindings, Section 6.4.4)"
      );
    }
    if (!isNonEmptyString(claim.attestationMethod)) {
      schemaDetectableErrors.push(
        "identity.crossDidBinding claim missing attestationMethod (required for attester-asserted bindings, Section 6.4.4)"
      );
    }
    if (!isIsoDateTime(claim.attestedAt)) {
      schemaDetectableErrors.push(
        "identity.crossDidBinding claim missing attestedAt (required for attester-asserted bindings, Section 6.4.4)"
      );
    }
  } else {
    notes.push(
      "cryptographic bindingProof/ceremonyProof carries the binding — the attester triple is OPTIONAL (Section 6.4.4)"
    );
  }
  if (claim.bindingProof !== undefined) {
    schemaDetectableErrors.push(...validateBindingProofShape(claim.bindingProof).errors);
  }
  if (claim.ceremonyProof !== undefined) {
    const c = validateCeremonyProofShape(claim.ceremonyProof);
    schemaDetectableErrors.push(...c.schemaDetectableErrors);
    evaluatorOnlyErrors.push(...c.evaluatorOnlyErrors);
    if (c.protocolNote) notes.push(c.protocolNote);
    if (c.attesterRolesNote) notes.push(c.attesterRolesNote);
  }
  const errors = [...schemaDetectableErrors, ...evaluatorOnlyErrors];
  return { valid: errors.length === 0, errors, schemaDetectableErrors, evaluatorOnlyErrors, notes };
}

/**
 * The slice of the v0.4 structural contract over a whole manifest:
 *   - every claims[].bindingProof / claims[].ceremonyProof validates (the
 *     reference asserts these on ANY claim type, not only crossDidBinding);
 *   - every identity.crossDidBinding claim satisfies Base §6.4.4.
 * Envelope members / signature / other subsystems belong to their own tasks.
 * Returns { valid, errors, schemaDetectableErrors, evaluatorOnlyErrors, notes }.
 */
export function validateZkpCeremonyStructural(manifest) {
  const schemaDetectableErrors = [];
  const evaluatorOnlyErrors = [];
  const notes = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      valid: false,
      errors: ["manifest must be an object"],
      schemaDetectableErrors: ["manifest must be an object"],
      evaluatorOnlyErrors: [],
      notes,
    };
  }
  for (const claim of claimsOf(manifest)) {
    if (claim["@type"] === "identity.crossDidBinding") {
      const r = validateCrossDidBindingClaimShape(claim);
      schemaDetectableErrors.push(...r.schemaDetectableErrors);
      evaluatorOnlyErrors.push(...r.evaluatorOnlyErrors);
      notes.push(...r.notes);
      continue; // nested proofs already validated inside the claim check
    }
    if (claim.bindingProof !== undefined) {
      schemaDetectableErrors.push(...validateBindingProofShape(claim.bindingProof).errors);
    }
    if (claim.ceremonyProof !== undefined) {
      const c = validateCeremonyProofShape(claim.ceremonyProof);
      schemaDetectableErrors.push(...c.schemaDetectableErrors);
      evaluatorOnlyErrors.push(...c.evaluatorOnlyErrors);
      if (c.protocolNote) notes.push(c.protocolNote);
    }
  }
  const errors = [...schemaDetectableErrors, ...evaluatorOnlyErrors];
  return { valid: errors.length === 0, errors, schemaDetectableErrors, evaluatorOnlyErrors, notes };
}

// ===========================================================================
// 2) FAIL-CLOSED DISPOSITION — the honesty keystone (task deliverable 2)
// ===========================================================================

/**
 * Per-claim binding-status provider's injectable seam
 * (`context.holderBindingStatusOf`). For claims carrying Tier-2/Tier-3 proof
 * material this is the disposition:
 *
 *   "failed"              — the proof is structurally malformed (EXT-T2/T3:
 *                           a malformed proof MUST be treated as a proof that
 *                           fails verification), OR a bindingProof sits on a
 *                           claim whose boundDids cardinality is not exactly 2
 *                           (EXT-T2 §T2.1 — never verify a sub-pair).
 *   "present-unverified"  — structurally well formed; NO cryptographic
 *                           verification exists in this evaluator (EXT-T2/T3
 *                           verification profiles are PREVIEW), so the proof
 *                           NEVER elevates trust. This is the ceiling.
 *
 * Claims with only a holderBinding or nothing fall back to
 * presence-based default. This provider NEVER returns "verified" —
 * there is no verifying code to report one.
 */
export function featureBindingStatusProvider(claim, manifest) {
  const c = claim && typeof claim === "object" ? claim : {};
  const hasZkOrCeremony = c.bindingProof !== undefined || c.ceremonyProof !== undefined;
  if (!hasZkOrCeremony) return defaultHolderBindingStatusOf(c, manifest);

  if (c.bindingProof !== undefined) {
    if (!validateBindingProofShape(c.bindingProof).valid) return BINDING_FAILED;
    // EXT-T2 §T2.1 pairwise cardinality (prose rule, REAL check): exactly 2.
    if (!Array.isArray(c.boundDids) || c.boundDids.length !== 2) return BINDING_FAILED;
  }
  if (c.ceremonyProof !== undefined) {
    if (!validateCeremonyProofShape(c.ceremonyProof).valid) return BINDING_FAILED;
  }
  return BINDING_PRESENT_UNVERIFIED; // NEVER "verified" — no ZK/ceremony crypto here.
}

/**
 * Manifest-level crossDidBindingStatus roll-up (failure-dominant, mirroring
 * the hub's holderBindingStatus discipline):
 *   "absent"              no claim carries cross-DID binding material
 *   "failed"              any Tier-2/3 proof malformed / cardinality-violating
 *   "present-unverified"  material present, shape-valid, NO crypto performed
 * ("verified" is unreachable — this module verifies nothing.)
 */
export function crossDidBindingStatusOf(manifest) {
  let status = BINDING_ABSENT;
  for (const claim of claimsOf(manifest)) {
    const isCdb = claim["@type"] === "identity.crossDidBinding";
    const hasProof = claim.bindingProof !== undefined || claim.ceremonyProof !== undefined;
    if (!isCdb && !hasProof) continue;
    let s;
    if (hasProof) {
      s = featureBindingStatusProvider(claim, manifest);
      if (s === BINDING_PRESENT_UNVERIFIED && isCdb && !validateCrossDidBindingClaimShape(claim).valid) {
        s = BINDING_FAILED; // claim-level structural defect (e.g. missing attester triple)
      }
    } else {
      // attester-asserted crossDidBinding (no cryptographic proof): its shape
      // decides failed vs present-unverified; verification is Tier-1 attester
      // policy, outside this module.
      s = validateCrossDidBindingClaimShape(claim).valid ? BINDING_PRESENT_UNVERIFIED : BINDING_FAILED;
    }
    if ((CDB_DOMINANCE[s] ?? 0) > (CDB_DOMINANCE[status] ?? 0)) status = s;
  }
  return status;
}

/**
 * evaluateProofDispositions — the composed evaluation slice: a
 * hub-mergeable receipt FRAGMENT recording the
 * fail-closed disposition of every Tier-2/Tier-3 proof on the manifest.
 *
 * INTERNALLY RUNS the tier engine with `featureBindingStatusProvider`
 * injected, so the fragment ALREADY CONTAINS the tier records
 * (trustTierUnsupported at the capability boundary / Tier-0 caps /
 * holderBindingStatus / effectiveTrustTier). Integrators merging this
 * fragment MUST NOT also merge a separate bare evaluateTrustTiers() fragment
 * for the same manifest.
 *
 * Disposition map (all fail closed; nothing is ever "verified"):
 *   structurally MALFORMED proof   → verdict "rejected" (reference-assert
 *       parity: these manifests fail structural validation), warning
 *       um:reason:structure:malformed, crossDidBindingStatus "failed".
 *   EXT-T2 cardinality violation   → proof treated as FAILING verification:
 *       provider reports "failed" → Tier-0 cap (holderBindingStatus
 *       "failed", effectiveTrustTier 0), warning um:reason:trust:binding-failed,
 *       crossDidBindingStatus "failed". NOT a manifest reject (schema accepts).
 *   shape-valid, tier REQUIRED above capability → capability record:
 *       claim trustTierUnsupported at the capability boundary — never
 *       downgraded, never verified (CONFORMANCE §2.15; EXT-T3 §T3.4).
 *   shape-valid, tier within capability → claim recorded "unverified" with the
 *       PREVIEW reason (reference posture: recognized claims record
 *       "unverified" rather than "verified"); crossDidBindingStatus
 *       "present-unverified" is a RECORDED POSTURE, not a warning.
 *
 * @param {object} manifest  v0.4-shaped manifest.
 * @param {object} context   { maxSupportedTrustTier = DEFAULT_MAX_SUPPORTED_TRUST_TIER }
 * @returns hub-mergeable fragment { engine, verdict, claimStatuses, warnings,
 *          crossDidBindingStatus?, holderBindingStatus?, effectiveTrustTier?,
 *          facetStatuses, proofDispositions[] (diagnostic, non-wire), preview }
 */
export function evaluateProofDispositions(manifest, context = {}) {
  const max = Number.isInteger(context.maxSupportedTrustTier)
    ? context.maxSupportedTrustTier
    : DEFAULT_MAX_SUPPORTED_TRUST_TIER;

  // ---- structural gate (reference-assert parity: malformed ⇒ rejected) ------
  const structural = validateZkpCeremonyStructural(manifest);
  if (!structural.valid) {
    return {
      engine: "runtime-zkp-ceremony",
      verdict: "rejected",
      rejectedBy: "runtime-structural-malformation",
      claimStatuses: [],
      facetStatuses: [],
      warnings: [{ code: WARN_STRUCTURE_MALFORMED, message: `Verify stage: ${structural.errors[0]}` }],
      crossDidBindingStatus: BINDING_FAILED,
      proofDispositions: [],
      preview: feature_PREVIEW_LABEL,
    };
  }

  // ---- tier pass with the provider injected --------------------
  const tier = evaluateTrustTiers(manifest, {
    maxSupportedTrustTier: max,
    holderBindingStatusOf: featureBindingStatusProvider,
  });

  const fragment = {
    engine: "runtime-zkp-ceremony",
    verdict: tier.verdict,
    claimStatuses: [...tier.claimStatuses],
    facetStatuses: [...tier.facetStatuses],
    warnings: [...tier.warnings],
    proofDispositions: [],
    preview: feature_PREVIEW_LABEL,
  };
  if (tier.holderBindingStatus !== undefined) fragment.holderBindingStatus = tier.holderBindingStatus;
  if (tier.effectiveTrustTier !== undefined) fragment.effectiveTrustTier = tier.effectiveTrustTier;

  // ---- per-proof dispositions (diagnostic rows + the within-capability record)
  const recordedRefs = new Set(fragment.claimStatuses.map((s) => s.claimRef));
  for (const claim of claimsOf(manifest)) {
    const hasProof = claim.bindingProof !== undefined || claim.ceremonyProof !== undefined;
    if (!hasProof) continue;
    const claimRef = refOf(claim);
    const claimTier = effectiveFloor(manifest?.requiredTrustTier, claim.requiredTrustTier);
    const providerStatus = featureBindingStatusProvider(claim, manifest);
    const shapes = [];
    if (claim.bindingProof !== undefined) {
      shapes.push({
        member: "bindingProof",
        type: String(claim.bindingProof?.type),
        profile: claim.bindingProof?.type === "ZkHdDerivationProof" ? "EXT-T2 Profile 2B" : "EXT-T2 Profile 2A",
      });
    }
    if (claim.ceremonyProof !== undefined) {
      const c = validateCeremonyProofShape(claim.ceremonyProof);
      shapes.push({
        member: "ceremonyProof",
        type: CEREMONY_PROOF_TYPE,
        profile: "EXT-T3",
        threshold: claim.ceremonyProof?.threshold,
        protocol: c.protocol,
        ...(c.protocolNote ? { protocolNote: c.protocolNote } : {}),
      });
    }

    let disposition;
    if (providerStatus === BINDING_FAILED) {
      // EXT-T2 §T2.1 cardinality (structural gate passed, so this is the
      // cardinality case): the proof FAILS verification; has already
      // recorded the Tier-0 cap when the claim is relied on at Tier 1+.
      disposition = "failed";
      fragment.warnings.push({
        code: WARN_BINDING_FAILED,
        message:
          `claim ${claimRef}: bindingProof on a claim whose boundDids cardinality is not exactly 2 — ` +
          "the validation is treated as FAILING verification and the claim is capped at Tier 0; a sub-pair is never selected (EXT-T2 Section T2.1)",
      });
    } else if (claimTier > max) {
      disposition = "trustTierUnsupported"; // already recorded it at the capability boundary
    } else {
      disposition = "present-unverified";
      if (!recordedRefs.has(claimRef)) {
        // Reference posture: recognized claims record "unverified", never
        // "verified" — the verification chain does not exist here (PREVIEW).
        fragment.claimStatuses.push({
          claimRef,
          status: "unverified",
          tier: 0,
          reason:
            "Tier-2/Tier-3 validation verification profile not implemented — structural shape only, fail closed; " +
            feature_PREVIEW_LABEL,
        });
        recordedRefs.add(claimRef);
      }
    }
    fragment.proofDispositions.push({
      claimRef,
      claimTier,
      maxSupportedTrustTier: max,
      shapes,
      structuralShape: "valid",
      cryptographicVerification: "not-performed (EXT-T2/EXT-T3 PREVIEW — fail closed)",
      disposition,
      neverVerified: true,
    });
  }

  // ---- the reserved hub slot (omitted reference-style when absent) ----
  const cdb = crossDidBindingStatusOf(manifest);
  if (cdb !== BINDING_ABSENT) fragment.crossDidBindingStatus = cdb;

  // Outcome contribution: unverified/pending records alone do not degrade
  //tier records already set verdict.
  return fragment;
}

// ===========================================================================
// 3) HOLDER-SIDE STRUCTURAL EMIT (task deliverable 3 — HOLD-10/11/12 shapes)
// ===========================================================================

/**
 * Emit a Profile-2A ZkLinkedSecretProof bindingProof (EXT-T2 §T2.1.1)
 * STRUCTURAL SHAPE. The proofValue/commitments are caller-supplied opaque
 * strings: this builder performs NO zero-knowledge proving — demo callers pass
 * placeholder bytes explicitly labeled structural-only. Throws on a shape that
 * would not validate.
 */
export function buildZkLinkedSecretBindingProof({
  cryptosuite = "bbs-2023", // the EXT-T2 §T2.1.1 pinned suite
  proofPurpose = "authentication",
  proofValue,
  commitmentA,
  commitmentB,
} = {}) {
  const validation = {
    type: "ZkLinkedSecretProof",
    cryptosuite,
    proofPurpose,
    proofValue,
    publicInputs: { commitmentA, commitmentB },
  };
  const r = validateBindingProofShape(validation);
  if (!r.valid) throw new Error(`buildZkLinkedSecretBindingProof: ${r.errors.join("; ")}`);
  return validation;
}

/**
 * Emit a Profile-2B ZkHdDerivationProof bindingProof (EXT-T2 §T2.1.2)
 * STRUCTURAL SHAPE. No Groth16/PLONK proving happens here (see honesty header).
 */
export function buildZkHdDerivationBindingProof({
  proofSystem = "groth16", // EXT-T2 §T2.1.2: the mandatory-to-implement system for VERIFIERS (none here)
  circuit,
  proofValue,
  publicKeyA,
  publicKeyB,
  derivationPathA,
  derivationPathB,
} = {}) {
  const validation = {
    type: "ZkHdDerivationProof",
    proofSystem,
    circuit,
    proofValue,
    publicInputs: { publicKeyA, publicKeyB, derivationPathA, derivationPathB },
  };
  const r = validateBindingProofShape(validation);
  if (!r.valid) throw new Error(`buildZkHdDerivationBindingProof: ${r.errors.join("; ")}`);
  return validation;
}

/**
 * Emit a ThresholdAttestationProof ceremonyProof (EXT-T3 §T3.1) STRUCTURAL
 * SHAPE. Enforces at emit time everything the evaluator enforces (M-of-N
 * format, quorum ≥ M distinct, ≤ N, M ≤ N) — the holder can never produce what
 * the evaluator rejects. `protocol` is OPTIONAL until wire freeze (transitional
 * note attached to the demo surface, not the wire object). No aggregate
 * signature is computed — `aggregateProof` is caller-supplied opaque bytes.
 */
export function buildThresholdCeremonyProof({ threshold, attesters, ceremonyId, aggregateProof, protocol, attesterRoles } = {}) {
  const validation = {
    type: CEREMONY_PROOF_TYPE,
    threshold,
    attesters,
    ceremonyId,
    aggregateProof,
    ...(protocol !== undefined ? { protocol } : {}),
    ...(attesterRoles !== undefined ? { attesterRoles } : {}),
  };
  const r = validateCeremonyProofShape(validation);
  if (!r.valid) throw new Error(`buildThresholdCeremonyProof: ${r.errors.join("; ")}`);
  return validation;
}

/**
 * Emit an identity.crossDidBinding claim (Base §6.4.4; HOLD-12). Enforces:
 *   - boundDids ≥ 2 (and EXACTLY 2 when a bindingProof is attached — EXT-T2
 *     §T2.1 pairwise cardinality, checked at emit so holders cannot produce a
 *     claim every conformant evaluator must fail);
 *   - the attester triple REQUIRED when no cryptographic proof carries the
 *     binding, OPTIONAL otherwise (the proof-only fixture path).
 */
export function buildCrossDidBindingClaim({
  id,
  issuer,
  boundDids,
  requiredTrustTier,
  bindingProof,
  ceremonyProof,
  attester,
  attestationMethod,
  attestedAt,
} = {}) {
  const claim = {
    ...(isNonEmptyString(id) ? { "@id": id } : {}),
    "@type": "identity.crossDidBinding",
    issuer,
    boundDids,
    ...(Number.isInteger(requiredTrustTier) ? { requiredTrustTier } : {}),
    ...(bindingProof !== undefined ? { bindingProof } : {}),
    ...(ceremonyProof !== undefined ? { ceremonyProof } : {}),
    ...(attester !== undefined ? { attester } : {}),
    ...(attestationMethod !== undefined ? { attestationMethod } : {}),
    ...(attestedAt !== undefined ? { attestedAt } : {}),
  };
  const r = validateCrossDidBindingClaimShape(claim);
  if (!r.valid) throw new Error(`buildCrossDidBindingClaim: ${r.errors.join("; ")}`);
  if (bindingProof !== undefined && (!Array.isArray(boundDids) || boundDids.length !== 2)) {
    throw new Error(
      "buildCrossDidBindingClaim: a claim carrying a bindingProof must list EXACTLY 2 boundDids (EXT-T2 Section T2.1 pairwise cardinality)"
    );
  }
  return claim;
}

/**
 * The three sample claims for the demo inspector — one per higher-tier proof
 * shape, every proof byte an OBVIOUS structural-only placeholder. Shapes mirror
 * the three valid conformance fixtures.
 */
export function buildZkpCeremonySampleClaims({ subjectDid = "did:web:demo.local:user:alice" } = {}) {
  const zkLinkedSecret = buildCrossDidBindingClaim({
    id: "urn:um:claim:runtime-sample-zk-linked-secret",
    issuer: subjectDid,
    boundDids: [subjectDid, "did:pkh:eip155:1:0xdemo"],
    requiredTrustTier: 2,
    bindingProof: buildZkLinkedSecretBindingProof({
      proofValue: "uSTRUCTURAL-ONLY-PLACEHOLDER-NOT-A-ZK-validation",
      commitmentA: "zDemoCommitmentA-structural-only",
      commitmentB: "zDemoCommitmentB-structural-only",
    }),
  });
  const zkHdDerivation = buildCrossDidBindingClaim({
    id: "urn:um:claim:runtime-sample-zk-hd-derivation",
    issuer: subjectDid,
    boundDids: [subjectDid, "did:key:z6MkDemoDerived"],
    requiredTrustTier: 2,
    bindingProof: buildZkHdDerivationBindingProof({
      circuit: "urn:uuid:circuit-hd-derivation-v1",
      proofValue: "uSTRUCTURAL-ONLY-PLACEHOLDER-NOT-A-GROTH16-validation",
      publicKeyA: "zDemoPubKeyA",
      publicKeyB: "zDemoPubKeyB",
      derivationPathA: "m/44'/0'/0'",
      derivationPathB: "m/44'/0'/1'",
    }),
  });
  const ceremony = buildCrossDidBindingClaim({
    id: "urn:um:claim:runtime-sample-ceremony",
    issuer: "did:web:notary-a.demo.local",
    boundDids: [subjectDid, "did:pkh:eip155:1:0xdemo"],
    requiredTrustTier: 3,
    attester: "did:web:notary-a.demo.local",
    attestationMethod: "Multi-party ceremony",
    attestedAt: "2026-07-05T00:00:00.000Z",
    ceremonyProof: buildThresholdCeremonyProof({
      threshold: "2-of-3",
      attesters: ["did:web:notary-a.demo.local", "did:web:notary-b.demo.local"],
      ceremonyId: "urn:um:ceremony:runtime-demo",
      aggregateProof: "zSTRUCTURAL-ONLY-PLACEHOLDER-NOT-AN-AGGREGATE-SIGNATURE",
    }),
  });
  return { zkLinkedSecret, zkHdDerivation, ceremony };
}

// ===========================================================================
// 4) DEMO SURFACE (Bucket-2 invented, honest) — the "higher-tier proof shapes"
//    inspector panel (task deliverable 4). Pure data; the UI wiring into
//    live-adapter.js is the a serialized edit.
// ===========================================================================

/**
 * buildProofShapesDemoSurface — display-ready data for the inspector panel:
 * the three higher-tier proof shapes (ZkLinkedSecretProof, ZkHdDerivationProof,
 * ThresholdAttestationProof), each with (a) its REAL structural-validity check
 * output and (b) its REAL fail-closed disposition through the engine on
 * this evaluator — labeled EXT-T2/EXT-T3 PREVIEW throughout. Nothing here is
 * hardcoded theater; every verdict is computed by the same code the fixture
 * surface runs.
 */
export function buildProofShapesDemoSurface(options = {}) {
  const max = Number.isInteger(options.maxSupportedTrustTier)
    ? options.maxSupportedTrustTier
    : DEFAULT_MAX_SUPPORTED_TRUST_TIER;
  const samples = buildZkpCeremonySampleClaims(options);
  const rows = [];
  for (const [key, label, profile] of [
    ["zkLinkedSecret", "Tier-2 ZKP binding — BBS+ linked secret", "EXT-T2 §T2.1.1 (Profile 2A) — PREVIEW"],
    ["zkHdDerivation", "Tier-2 ZKP binding — HD derivation", "EXT-T2 §T2.1.2 (Profile 2B) — PREVIEW"],
    ["ceremony", "Tier-3 multi-party ceremony — threshold attestation", "EXT-T3 §T3.1 — PREVIEW"],
  ]) {
    const claim = samples[key];
    const shape = validateCrossDidBindingClaimShape(claim);
    const fragment = evaluateProofDispositions(
      { requiredTrustTier: 0, claims: [claim] },
      { maxSupportedTrustTier: max }
    );
    const row = {
      key,
      label,
      profile,
      claim,
      structural_validity: { valid: shape.valid, errors: shape.errors, notes: shape.notes },
      fail_closed_disposition: {
        claim_status: fragment.claimStatuses[0] || null,
        crossDidBindingStatus: fragment.crossDidBindingStatus || BINDING_ABSENT,
        verdict_contribution: fragment.verdict,
        explain:
          `required tier ${claim.requiredTrustTier} on a Tier-${max} evaluator ⇒ ` +
          (claim.requiredTrustTier > max
            ? `recorded "trustTierUnsupported" at the capability boundary (tier ${max}) — NEVER downgraded, NEVER verified (Base §6.4.5; CONFORMANCE §2.15)`
            : `recorded "unverified" — the verification profile is PREVIEW and unimplemented; the validation NEVER elevates trust`),
      },
    };
    if (key === "ceremony") {
      row.transitional_protocol_note = feature_PROTOCOL_TRANSITIONAL_NOTE;
    }
    rows.push(row);
  }
  return {
    title: "Higher-tier validation shapes (EXT-T2 / EXT-T3 PREVIEW)",
    evaluator_max_supported_trust_tier: max,
    shapes: rows,
    preview_label: feature_PREVIEW_LABEL,
    honesty:
      "Shape validation, cardinality/quorum counting and the fail-closed tier dispositions are REAL " +
      "(runtime + runtime). NO zero-knowledge validation, threshold signature, or ceremony transcript is " +
      "generated or verified anywhere in this demo: validation bytes are labeled placeholders, every " +
      "disposition fails closed, and no validation is ever reported verified or Tier-2/Tier-3-met. " +
      "The portaling age validation remains an issuer-asserted signed VC — it is NOT zero-knowledge " +
      "and is not relabeled by this panel. No um_conformance claim is made by this panel.",
  };
}

// ===========================================================================
// 5) FIXTURE SURFACE — the five expected.json rows owns
// ===========================================================================

/** The 5 fixture files owns. */
export const feature_FIXTURE_FILENAMES = Object.freeze([
  "valid/manifest-with-zkp-binding-validation.jsonld",
  "valid/cross-did-binding-validation-only.jsonld",
  "valid/manifest-with-ceremony-validation.jsonld",
  "invalid/binding-validation-invalid-type.jsonld",
  "invalid/ceremony-validation-insufficient-attesters.jsonld",
]);

/** Minimal envelope checks (v0.4 Base §1.2/§1.3) — local mirror of the
 *  holder-binding.mjs internal helper (not exported there; re-implemented
 *  under the shared-file discipline rather than editing fenced file). */
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
  const hasType = t === "um:Manifest" || (Array.isArray(t) && t.includes("um:Manifest"));
  if (!hasType) errors.push("Missing um:Manifest in @type");
  if (manifest.manifestVersion !== "0.4") errors.push("manifestVersion must be 0.4");
  if (!isNonEmptyString(manifest.subject)) errors.push("Missing subject");
  if (!isIsoDateTime(manifest.issuedAt)) errors.push("issuedAt must be an ISO 8601 date-time");
  if (!isIsoDateTime(manifest.expiresAt)) errors.push("expiresAt must be an ISO 8601 date-time");
  if (
    isIsoDateTime(manifest.issuedAt) &&
    isIsoDateTime(manifest.expiresAt) &&
    Date.parse(manifest.issuedAt) > Date.parse(manifest.expiresAt)
  ) {
    errors.push("issuedAt must be <= expiresAt");
  }
  return errors;
}

/**
 * FULL structural verdict for a fixture (clock-independent):
 * envelope basics → shapes (BOTH layers: schema-detectable +
 * evaluator-only) → Profile A signature LAST over the v0.4 signing input
 * (REAL Ed25519 — the three valid fixtures carry genuine signatures; shape
 * defects report their own reason before any crypto runs).
 * Returns { result: "accept"|"reject", reasons, notes, checks }.
 */
export async function structuralVerdictZkpCeremony(manifest) {
  const reasons = [];
  reasons.push(...envelopeErrors(manifest));
  const runtime = manifest && typeof manifest === "object" ? validateZkpCeremonyStructural(manifest) : { errors: [], notes: [] };
  reasons.push(...runtime.errors);
  let sigReport = null;
  if (reasons.length === 0) {
    sigReport = await verifyManifestProfileA(manifest);
    if (!sigReport.ok) reasons.push(`signature verification failed: ${sigReport.reason}`);
  }
  return {
    result: reasons.length === 0 ? "accept" : "reject",
    reasons,
    notes: runtime.notes || [],
    checks: { signature: sigReport ? sigReport.reason : "not-evaluated" },
  };
}

/**
 * SCHEMA-DETECTABLE-ONLY verdict for the slice — the CONFORMANCE §5.3
 * split the verify script proves against each entry's `schemaValidation`:
 * runs ONLY the checks the published JSON Schema expresses (type enums,
 * per-type required fields, threshold pattern, attester-triple conditionals),
 * NOT the evaluator-only quorum count, prose rules, or signature crypto.
 * Scope-labeled: this is the slice, not a whole-schema sweep (the
 * envelope members of these five fixtures are schema-clean by construction).
 */
export function schemaVerdictZkpCeremony(manifest) {
  const r = validateZkpCeremonyStructural(manifest);
  return {
    result: r.schemaDetectableErrors.length === 0 ? "accept" : "reject",
    reasons: r.schemaDetectableErrors,
    evaluatorOnlyReasonsExcluded: r.evaluatorOnlyErrors,
  };
}

/**
 * Evaluate ONE fixture against its expected.json entry contract.
 * All five entries are STRUCTURAL-mode (none carries
 * validationMode "evaluation"); the handler routes defensively anyway:
 *   entry.validationMode "evaluation" ⇒ evaluateProofDispositions verdict
 *   otherwise                         ⇒ structuralVerdictZkpCeremony
 * Returns { result: "accept"|"reject", reason, fragment? } — the adapter shape
 * the runner pattern uses, so the shared v0.4 runner can dispatch
 * fixtures to this handler with no impedance mismatch.
 */
export async function featureFixtureHandler(fixtureJson, expectedEntry = {}) {
  if (expectedEntry.validationMode === "evaluation") {
    const fragment = evaluateProofDispositions(fixtureJson, expectedEntry.evaluationContext || {});
    return {
      result: fragment.verdict === "rejected" ? "reject" : "accept",
      reason: fragment.warnings?.[0]?.message || fragment.verdict,
      fragment,
    };
  }
  const verdict = await structuralVerdictZkpCeremony(fixtureJson);
  return {
    result: verdict.result,
    reason:
      verdict.reasons.join("; ") ||
      ["structural contract satisfied", ...verdict.notes].join(" — "),
  };
}

/**
 * Registration hook for the shared v0.4 conformance runner. Contract
 * identical to registerHolderBinding: registry.register(filename, asyncHandler).
 * The orchestrator wires it with exactly:
 *   import { registerZkpCeremony } from "../manifest/zkp-ceremony.mjs";
 *   registerZkpCeremony(registry);
 */
export function registerZkpCeremony(registry) {
  if (!registry || typeof registry.register !== "function") {
    throw new Error("registerZkpCeremony: registry with a register(filename, handler) function required");
  }
  for (const filename of feature_FIXTURE_FILENAMES) {
    registry.register(filename, featureFixtureHandler);
  }
  return feature_FIXTURE_FILENAMES.length;
}
