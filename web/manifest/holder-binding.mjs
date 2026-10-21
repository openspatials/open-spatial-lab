// v0.4 holder-binding subsystem (all three modes) + did-auth
// presentation proof + claim-proof VP size limits (gap-register G2).
//
// This module is the EXT-T1 Stage-2 sub-step owner for the demo:
//   (2a) holder-binding verification  — EXT-T1 §T1.1 / §T1.1.1
//   (2b) presentation-proof           — EXT-T1 §T1.2 / §T1.4 sub-step 2b
//   claim-proof VP size limits        — Base §6.4.3 / EXT-T1 §T1.5.1 (G2)
//   keyRefResolution posture          — Base §1.6.4 (unresolved ⇒ Tier-0 cap)
//
// Spec sources (READ-ONLY, ):
//   spec/v0.4/schema.json            $defs.holderBinding / $defs.presentationProof
//   spec/v0.4/CONFORMANCE.md         §2.9 / §2.10 (evaluator MUSTs 9/10), §9 (at-risk)
//   docs/spec-v0.4/ext-t1.html       T1.1, T1.1.1, T1.2, T1.4, T1.5.1
//   conformance/v0.4/expected.json   the 12 fixture entries this change owns
//
// THE did-auth BYTE RECIPE (EXT-T1 §T1.2 — empirically confirmed against the
// suite fixture valid/manifest-with-presentation-proof.jsonld):
//   proofValue = Ed25519-sign(
//       SHA-256( JCS(manifest − {signature, presentationProof, postQuantumSignature}) )  // 32 raw bytes
//    || UTF-8(challenge) || UTF-8(audience) || UTF-8(created) )                          // in that order
//   signed by the MANIFEST SIGNING KEY (DID Auth by the subject; the suite embeds it
//   as signature.publicKeySpkiB64 — DID resolution is deliberately out of suite scope).
//   presentationProof is EXCLUDED from the manifest signing input (Base §1.6.3) — the
// library computeSigningInput is already version-aware for v0.4.
//
// ---------------------------------------------------------------------------
// HONESTY CEILING — what is REAL vs PREVIEW/fail-closed (machine-readable
// descriptor: feature_CONFORMANCE below; every `real:true` is exercised by
// web/manifest/verify.mjs against the external suite or live crypto):
//   REAL   did-auth presentationProof     — full Ed25519 byte-recipe verify (issue+verify)
//   REAL   reciprocal-control binding     — Ed25519 verify of subjectProof/boundDidProof
//                                           over UTF-8(manifest @id) WHEN keys are
//                                           resolvable (embedded SPKI / did:key); the
//                                           demo issues real material. Unresolvable or
//                                           invalid proofs FAIL CLOSED (status "failed").
//   REAL   claim-proof VP size limits     — 50 KB per embedded VP / 500 KB per manifest
//   REAL keyRefResolution posture — offline ladder; did:example ⇒ "unresolved"
//   SHAPE  sd-jwt-kb holder binding       — structural emit+validation ONLY; evaluation
//          (PREVIEW)                        records "unsupported-mode" and caps at Tier 0
//                                           (no SD-JWT/KB-JWT crypto here) — never "verified".
//   SHAPE  bbs-holder-commitment binding  — structural emit+validation ONLY; evaluation
//          (PREVIEW)                        records "unsupported-mode" and caps at Tier 0
//                                           (no BLS12-381/BBS+ crypto) — never "verified".
//   CLOSED sd-jwt-kb / bbs-derived        — presentationProof.proofType values that are
//          (at-risk)                        AT-RISK per CONFORMANCE §9: no fixtures, no
//                                           reference implementation. This evaluator FAILS
//                                           THEM CLOSED (status "failed", manifest rejected
//                                           for interactive verification) — NEVER "verified".
// This module flips NO um_conformance flag. Scope: the 12 fixtures + the
// crossing demo surface. NOT the full six-stage evaluator;
// NOT facet sealing; NOT the full tier engine.
// ---------------------------------------------------------------------------
//
// FILE DISCIPLINE: this is a NEW, specific module. It imports only the
// signing library (read-only reuse) and is imported by nothing yet.
// Registration into the shared v0.4 conformance runner is via registerHolderBinding()
// (see the hook section at the bottom) — one wiring line, applied by the
// integration step, not by this module.

import { jcsCanonicalizeToBytes } from "../signing/jcs-rfc8785.mjs";
import {
  derivePublicKeyRaw,
  rawPublicKeyToSpki,
  signBytes,
  verifyBytes,
} from "../signing/ed25519.mjs";
import { base64ToBytes, bytesToBase64, bytesToBase64Url, bytesToHex, utf8Encode } from "../signing/codecs.mjs";
import { publicKeyToDidKey, resolveKeyRefOffline } from "../signing/did.mjs";
import { verifyManifestProfileA, computeSigningInput } from "../signing/um-signature-profile-a.mjs";

// ===========================================================================
// Constants (schema.json $defs + EXT-T1 value sets)
// ===========================================================================

export const HOLDER_BINDING_MODES = Object.freeze(["sd-jwt-kb", "bbs-holder-commitment", "reciprocal-control"]);
export const PRESENTATION_PROOF_TYPES = Object.freeze(["sd-jwt-kb", "bbs-derived", "did-auth"]);
/** Only did-auth is exercised by the v0.4 suite + reference impl (CONFORMANCE §9). */
export const IMPLEMENTED_PRESENTATION_PROOF_TYPES = Object.freeze(["did-auth"]);
/** At-risk / specification-only — MUST fail closed, never reported verified. */
export const AT_RISK_PRESENTATION_PROOF_TYPES = Object.freeze(["sd-jwt-kb", "bbs-derived"]);

/** VP size limits per Base §6.4.3 / EXT-T1 §T1.5.1 (gap-register G2). */
export const VP_EMBEDDED_LIMIT_BYTES = 50 * 1024;
export const VP_TOTAL_LIMIT_BYTES = 500 * 1024;

/** Receipt value sets (Base §3.3.1.1 / EXT-T1 §T1.1.1, §T1.2). */
export const HOLDER_BINDING_STATUSES = Object.freeze(["verified", "failed", "unsupported-mode", "absent"]);
export const PRESENTATION_PROOF_STATUSES = Object.freeze(["verified", "failed", "missing-required", "absent"]);

// ---------------------------------------------------------------------------
// AV-5 HARDENING (hardening report FINDING 1). The EXT-T1 §T1.1.1 reciprocal
// recipe — both proofs sign only UTF-8(manifest @id) — is REPLAYABLE: a published
// boundDidProof transplants into an attacker-authored manifest that reuses the same
// @id, forging a "verified" Tier-1 binding to a DID the presenter does not control.
// We do TWO honest things and change NOTHING about the sound modes (did-auth,
// sd-jwt-kb/bbs previews):
//   (1) STAY CONFORMANT but STOP SILENTLY OVERCLAIMING — a reciprocal binding that
//       verifies under the literal T1.1.1 recipe still reports holderBindingStatus
//       "verified" (external suite + verify C1 expect that), but the receipt
//       now carries a VISIBLE warning (RECIPROCAL_REPLAYABLE_WARNING_CODE).
//   (2) Offer an OPT-IN, beyond-spec FORWARD proposal — the HARDENED profile below —
//       whose two proofs sign a domain-separated message binding a FRESH nonce +
//       BOTH DIDs (the subject side derived from the ACTUAL embedded key, not a
//       claimed string) + the manifest @id, so a captured boundDidProof cannot be
//       transplanted (it committed to the victim's subject key). This is the fix we
//       propose to the UM WG for T1.1.1; it alters the signed-message byte recipe.
/** Opt-in, beyond-spec replay-resistant reciprocal-control profile (AV-5 fix). */
export const RECIPROCAL_HARDENED_PROFILE = "um:reciprocal-control:hardened-v2";
/** Domain-separation tag for the hardened reciprocal signed message. */
export const RECIPROCAL_HARDENED_DOMAIN = "um:reciprocal-control:hardened-v2";
/** Attached to any receipt whose reciprocal binding verified under the replayable
 *  spec T1.1.1 recipe — honest disclosure, never a silent Tier-0→Tier-1 overclaim. */
export const RECIPROCAL_REPLAYABLE_WARNING_CODE = "um:warning:reciprocal-binding-replayable";

// Machine-readable scoped-claim descriptor (pattern: SIGNING_CONFORMANCE /
// UM_MANIFEST_EMISSION). Every `true` is backed by verify.mjs output.
export const feature_CONFORMANCE = Object.freeze({
  wo: "runtime",
  standard: "Universal Manifest v0.4 EXT-T1 (holder binding T1.1 + presentation validation T1.2 + VP limits T1.5.1)",
  fixtures_owned: 12, // 11 named by the task + invalid/claim-proof-oversize-vp (G2)
  // REAL crypto surfaces:
  did_auth_presentation_proof_real: true, // Ed25519 over signing-input hash||challenge||audience||created
  reciprocal_control_crypto_when_resolvable: true, // Ed25519 over UTF-8(manifest @id), both sides
  reciprocal_control_spec_recipe_replay_flagged: true, // AV-5: spec T1.1.1 verified-BUT-FLAGGED (um:warning:reciprocal-binding-replayable) — never a silent overclaim
  reciprocal_control_hardened_profile_replay_resistant: true, // AV-5 fix: opt-in hardened profile binds nonce+both DIDs+@id ⇒ transplant/replay rejected (beyond-spec FORWARD proposal)
  claim_proof_vp_size_limits_real: true, // 50 KB per VP / 500 KB total, byte-counted (string claimProofs bounded too — AV-14)
  keyref_resolution_posture_real: true, // offline ladder; unresolved ⇒ Tier-0 cap
  signing_input_exclusion_v04: true, // {signature, presentationProof, postQuantumSignature} —, vectored
  // PREVIEW / fail-closed surfaces (NEVER reported verified):
  sd_jwt_kb_holder_binding_verification: false, // structural only ⇒ "unsupported-mode", Tier-0 cap
  bbs_holder_commitment_verification: false, // structural only ⇒ "unsupported-mode", Tier-0 cap
  sd_jwt_kb_presentation_proof: false, // AT-RISK (CONFORMANCE §9) ⇒ fail closed, rejected
  bbs_derived_presentation_proof: false, // AT-RISK (CONFORMANCE §9) ⇒ fail closed, rejected
  full_six_stage_evaluator: false, // composes; this is the Stage-2 2a/2b slice
  um_conformance_flag_flipped: false,
  scoped_claim:
    "runtime implements REAL did-auth presentation validation (issue + verify, byte-exact per EXT-T1 T1.2), " +
    "REAL reciprocal-control binding crypto over the manifest @id where key material resolves, REAL " +
    "VP size limits, and structural emit/validation for all three holderBinding modes. sd-jwt-kb and " +
    "bbs modes/proofTypes have NO crypto here: bindings record 'unsupported-mode' (Tier-0 cap) and " +
    "at-risk proofTypes are failed closed — never verified. This is the Stage-2 (2a/2b) slice, not " +
    "the full six-stage evaluator. AV-5 hardening: the literal T1.1.1 reciprocal recipe is replay-" +
    "vulnerable, so a binding verified under it is FLAGGED on the receipt (um:warning:reciprocal-" +
    "binding-replayable) rather than silently overclaimed, and an opt-in hardened profile " +
    "(um:reciprocal-control:hardened-v2, binding nonce+both DIDs+@id) resists the transplant/replay. " +
    "AV-14 hardening: string/array-of-string claimProofs are length-bounded so oversize data cannot " +
    "evade the 50 KB/500 KB VP caps as a nominal 'URI reference'.",
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
function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) unavailable — need Node >= 18.4 or a modern browser");
  return s;
}
async function sha256(bytes) {
  return new Uint8Array(await subtle().digest("SHA-256", bytes));
}
/** UTF-8 byte length without Buffer (browser-safe). */
function utf8ByteLength(str) {
  return utf8Encode(str).length;
}

// ===========================================================================
// 1) STRUCTURAL SURFACE — shape validation (schema.json $defs parity)
// ===========================================================================

/**
 * Validate a holderBinding object per schema.json $defs.holderBinding +
 * EXT-T1 §T1.1: mode enum + per-mode REQUIRED fields.
 * Returns { valid, errors: string[] } — error strings mirror the reference
 * implementation's diagnostics (non-normative, but keeps triage easy).
 */
export function validateHolderBindingShape(binding, claimType = "claim") {
  const errors = [];
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return { valid: false, errors: [`claim ${claimType}: holderBinding must be an object`] };
  }
  if (!HOLDER_BINDING_MODES.includes(binding.mode)) {
    return {
      valid: false,
      errors: [`claim ${claimType}: holderBinding.mode must be one of ${HOLDER_BINDING_MODES.join("|")}`],
    };
  }
  if (binding.mode === "sd-jwt-kb") {
    if (!isNonEmptyString(binding.cnfThumbprint)) {
      errors.push(`claim ${claimType}: holderBinding.cnfThumbprint is required for sd-jwt-kb mode`);
    }
  } else if (binding.mode === "bbs-holder-commitment") {
    // EXT-T1 §T1.1.1: commitment + proofValue are REQUIRED for this mode.
    if (!isNonEmptyString(binding.commitment)) {
      errors.push(
        `claim ${claimType}: holderBinding.commitment is required for bbs-holder-commitment mode (EXT-T1 Section T1.1.1)`
      );
    }
    if (!isNonEmptyString(binding.proofValue)) {
      errors.push(
        `claim ${claimType}: holderBinding.proofValue is required for bbs-holder-commitment mode (EXT-T1 Section T1.1.1)`
      );
    }
  } else if (binding.mode === "reciprocal-control") {
    if (!isNonEmptyString(binding.boundDid)) {
      errors.push(`claim ${claimType}: holderBinding.boundDid is required for reciprocal-control mode`);
    }
    if (!isNonEmptyString(binding.subjectProof)) {
      errors.push(`claim ${claimType}: holderBinding.subjectProof is required for reciprocal-control mode`);
    }
    if (!isNonEmptyString(binding.boundDidProof)) {
      errors.push(`claim ${claimType}: holderBinding.boundDidProof is required for reciprocal-control mode`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a presentationProof object per schema.json $defs.presentationProof:
 * REQUIRED proofType (enum) / challenge / audience / created / proofValue.
 */
export function validatePresentationProofShape(validation) {
  const errors = [];
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) {
    return { valid: false, errors: ["presentationProof must be an object"] };
  }
  if (!PRESENTATION_PROOF_TYPES.includes(validation.proofType)) {
    errors.push(`presentationProof.proofType must be one of ${PRESENTATION_PROOF_TYPES.join("|")}`);
  }
  if (!isNonEmptyString(validation.challenge)) errors.push("presentationProof: missing challenge");
  if (!isNonEmptyString(validation.audience)) errors.push("presentationProof: missing audience");
  if (!isIsoDateTime(validation.created)) errors.push("presentationProof.created must be an ISO 8601 date-time");
  if (!isNonEmptyString(validation.proofValue)) errors.push("presentationProof: missing proofValue");
  return { valid: errors.length === 0, errors };
}

/**
 * G2 — claim-proof VP size limits (Base §6.4.3, EXT-T1 §T1.5.1):
 * each EMBEDDED VP (object entry) at most 50 KB; at most 500 KB total across
 * all claims in one manifest. A URI-string claimProof carries no embedded
 * payload (T1.5.1 allows it to be fetched on demand), so it is NOT counted
 * toward the total — BUT it MUST be a short reference: a string over the 50 KB
 * per-VP limit is embedded data smuggled as a "URI" and is REJECTED, closing the
 * AV-14 bypass (the same guard applies to string entries inside an array).
 * Byte counting is UTF-8 over JSON.stringify of each embedded object entry (matches
 * the reference implementation's measureEmbeddedVpBytes).
 * Returns { valid, errors, totalBytes, entries: [{claimRef, bytes}] }.
 */
export function checkClaimProofSizeLimits(manifest) {
  const errors = [];
  const entries = [];
  let totalBytes = 0;
  const claims = Array.isArray(manifest?.claims) ? manifest.claims : [];
  for (const claim of claims) {
    const claimRef = isNonEmptyString(claim?.["@id"]) ? claim["@id"] : claim?.["@type"];
    const cp = claim?.claimProof;
    if (cp === undefined || cp === null) continue;
    const list = Array.isArray(cp) ? cp : [cp];
    for (const entry of list) {
      if (typeof entry === "string") {
        // URI-reference form: uncounted (no embedded payload) but length-bounded so
        // arbitrarily large data cannot ride in as a "URI reference" (AV-14 hardening).
        const strBytes = utf8ByteLength(entry);
        if (strBytes > VP_EMBEDDED_LIMIT_BYTES) {
          errors.push(
            `claim ${claimRef}: string claimProof is ${strBytes} bytes — a claimProof URI reference MUST be a short reference, not embedded data; exceeds the 50 KB per-VP size limit (Section 6.4.3, EXT-T1 Section T1.5.1)`
          );
        }
        continue; // legitimate short URI: carries no embedded payload
      }
      if (!entry || typeof entry !== "object") continue; // number/boolean: nothing to measure
      const bytes = utf8ByteLength(JSON.stringify(entry));
      entries.push({ claimRef, bytes });
      if (bytes > VP_EMBEDDED_LIMIT_BYTES) {
        errors.push(
          `claim ${claimRef}: embedded claimProof VP is ${bytes} bytes — exceeds the 50 KB per-VP size limit (Section 6.4.3, EXT-T1 Section T1.5.1)`
        );
      }
      totalBytes += bytes;
    }
  }
  if (totalBytes > VP_TOTAL_LIMIT_BYTES) {
    errors.push(
      `total embedded VP payload across claims is ${totalBytes} bytes — exceeds the 500 KB limit (Section 6.4.3, EXT-T1 Section T1.5.1)`
    );
  }
  return { valid: errors.length === 0, errors, totalBytes, entries };
}

/**
 * The slice of the v0.4 structural contract, over a whole manifest:
 *   - every claims[].holderBinding validates per its mode (T1.1)
 *   - presentationProof (when present) has the required five members (T1.2)
 *   - claim-proof VP size limits hold (T1.5.1 — G2)
 * Envelope members / signature / other subsystems belong to their own tasks; the
 * shared runner composes. Returns { valid, errors }.
 */
export function validateHolderBindingStructural(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["manifest must be an object"] };
  }
  const claims = Array.isArray(manifest.claims) ? manifest.claims : [];
  for (const claim of claims) {
    if (claim && typeof claim === "object" && claim.holderBinding !== undefined) {
      const r = validateHolderBindingShape(claim.holderBinding, claim["@type"]);
      errors.push(...r.errors);
    }
  }
  if (manifest.presentationProof !== undefined) {
    const r = validatePresentationProofShape(manifest.presentationProof);
    errors.push(...r.errors);
  }
  const sizes = checkClaimProofSizeLimits(manifest);
  errors.push(...sizes.errors);
  return { valid: errors.length === 0, errors };
}

// ===========================================================================
// 2) HOLDER SIDE — attach bindings + presentation proofs (real material)
// ===========================================================================

/**
 * Structural emit support for ALL THREE holderBinding modes (HOLD-08).
 * Validates the produced shape before returning; throws on an invalid recipe.
 *   buildHolderBinding("sd-jwt-kb", { cnfThumbprint })
 *   buildHolderBinding("bbs-holder-commitment", { commitment, proofValue, pseudonymScope? })
 *   buildHolderBinding("reciprocal-control", { boundDid, subjectProof, boundDidProof })
 */
export function buildHolderBinding(mode, fields = {}) {
  const binding = { mode, ...fields };
  const r = validateHolderBindingShape(binding, "(emit)");
  if (!r.valid) throw new Error(`buildHolderBinding: ${r.errors.join("; ")}`);
  return binding;
}

/**
 * Demo-default REAL reciprocal-control binding (EXT-T1 §T1.1 mode 3):
 * both the manifest subject key and the bound-DID key Ed25519-sign the SAME
 * challenge — the UTF-8 bytes of the manifest @id.
 *   opts.manifestId          the manifest @id the proofs sign (REQUIRED)
 *   opts.subjectPrivateKey subject signing key
 *   opts.boundDidPrivateKey  bound-DID signing key
 *   opts.boundDid            OPTIONAL explicit bound DID; default did:key of boundDidPrivateKey
 * Returns { binding, boundDid } where binding is schema-valid reciprocal-control.
 */
export async function makeReciprocalControlBinding(opts = {}) {
  const { manifestId, subjectPrivateKey, boundDidPrivateKey } = opts;
  if (!isNonEmptyString(manifestId)) throw new Error("makeReciprocalControlBinding: manifestId required");
  if (!subjectPrivateKey || !boundDidPrivateKey) {
    throw new Error("makeReciprocalControlBinding: subjectPrivateKey and boundDidPrivateKey required");
  }
  const challengeBytes = utf8Encode(manifestId);
  const [subjectSig, boundSig, boundRaw] = await Promise.all([
    signBytes(challengeBytes, subjectPrivateKey),
    signBytes(challengeBytes, boundDidPrivateKey),
    derivePublicKeyRaw(boundDidPrivateKey),
  ]);
  const boundDid = isNonEmptyString(opts.boundDid) ? opts.boundDid : publicKeyToDidKey(boundRaw);
  const binding = buildHolderBinding("reciprocal-control", {
    boundDid,
    subjectProof: bytesToBase64Url(subjectSig),
    boundDidProof: bytesToBase64Url(boundSig),
  });
  return { binding, boundDid };
}

/** Normalize an Ed25519 public key to its 32 raw bytes (accepts the 44-byte SPKI
 *  DER form — raw key is the trailing 32 bytes — or an already-raw 32-byte key). */
function toRawEd25519PublicKey(key) {
  if (!(key instanceof Uint8Array)) return null;
  if (key.length === 32) return key;
  if (key.length > 32) return key.slice(-32); // SPKI DER: 12-byte header || 32-byte raw key
  return null;
}

/** Fresh, unique-per-binding nonce for the hardened reciprocal profile. */
function freshReciprocalNonce() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `um-reciprocal-nonce-${bytesToHex(bytes)}`;
}

/**
 * HARDENED reciprocal signed-message bytes (beyond-spec AV-5 fix). Both proofs
 * sign this domain-separated message instead of the bare @id:
 *   UTF-8( TAG "\n" nonce "\n" subjectDidKey "\n" boundDid "\n" manifestId )
 * where subjectDidKey is the did:key of the ACTUAL manifest subject key (derived
 * at verify time from the embedded key — never a claimed string). Binding the
 * counterparty identity + a fresh nonce + the @id makes a captured boundDidProof
 * non-transplantable: it committed to the victim's subject key, so re-verifying it
 * under any other embedded key fails closed. Exported so adversarial harnesses can
 * construct a correct subject-side proof and isolate the replayed bound side.
 */
export function buildReciprocalHardenedMessage({ nonce, subjectDidKey, boundDid, manifestId }) {
  return utf8Encode(`${RECIPROCAL_HARDENED_DOMAIN}\n${nonce}\n${subjectDidKey}\n${boundDid}\n${manifestId}`);
}

/**
 * Opt-in HARDENED reciprocal-control binding (beyond-spec FORWARD proposal; the
 * AV-5 fix). Same schema shape as the spec mode (mode "reciprocal-control" with
 * boundDid/subjectProof/boundDidProof) PLUS bindingProfile = RECIPROCAL_HARDENED_PROFILE
 * and a fresh nonce; both proofs sign buildReciprocalHardenedMessage(...). The
 * manifest MUST subsequently be signed with the SAME subjectPrivateKey so the
 * embedded key matches the subjectDidKey the verifier re-derives.
 *   opts.manifestId          the manifest @id (REQUIRED)
 *   opts.subjectPrivateKey   subject signing key (also signs the manifest envelope)
 *   opts.boundDidPrivateKey  bound-DID signing key
 *   opts.boundDid            OPTIONAL explicit bound DID; default did:key of boundDidPrivateKey
 *   opts.nonce               OPTIONAL explicit nonce; default a fresh random nonce
 * Returns { binding, boundDid, nonce, subjectDidKey }.
 */
export async function makeReciprocalControlBindingHardened(opts = {}) {
  const { manifestId, subjectPrivateKey, boundDidPrivateKey } = opts;
  if (!isNonEmptyString(manifestId)) throw new Error("makeReciprocalControlBindingHardened: manifestId required");
  if (!subjectPrivateKey || !boundDidPrivateKey) {
    throw new Error("makeReciprocalControlBindingHardened: subjectPrivateKey and boundDidPrivateKey required");
  }
  const [subjectRaw, boundRaw] = await Promise.all([
    derivePublicKeyRaw(subjectPrivateKey),
    derivePublicKeyRaw(boundDidPrivateKey),
  ]);
  const subjectDidKey = publicKeyToDidKey(subjectRaw);
  const boundDid = isNonEmptyString(opts.boundDid) ? opts.boundDid : publicKeyToDidKey(boundRaw);
  const nonce = isNonEmptyString(opts.nonce) ? opts.nonce : freshReciprocalNonce();
  const message = buildReciprocalHardenedMessage({ nonce, subjectDidKey, boundDid, manifestId });
  const [subjectSig, boundSig] = await Promise.all([
    signBytes(message, subjectPrivateKey),
    signBytes(message, boundDidPrivateKey),
  ]);
  const binding = buildHolderBinding("reciprocal-control", {
    boundDid,
    subjectProof: bytesToBase64Url(subjectSig),
    boundDidProof: bytesToBase64Url(boundSig),
    bindingProfile: RECIPROCAL_HARDENED_PROFILE,
    nonce,
  });
  return { binding, boundDid, nonce, subjectDidKey };
}

/**
 * Compute the did-auth presentation-proof MESSAGE bytes (EXT-T1 §T1.2):
 *   SHA-256(signing input) as 32 raw bytes || UTF-8(challenge) || UTF-8(audience) || UTF-8(created)
 * The signing input is the Base §1.6.3 canonical bytes — manifest minus
 * {signature, presentationProof, postQuantumSignature} (computeSigningInput,
 * already version-aware for v0.4; forced here regardless of manifestVersion so the
 * recipe is stable even for drafts).
 */
export async function didAuthProofMessage(manifest, { challenge, audience, created }) {
  const input = computeSigningInput(manifest, {
    exclude: ["presentationProof", "postQuantumSignature"],
  });
  const hash = await sha256(input);
  return concatBytes([hash, utf8Encode(challenge), utf8Encode(audience), utf8Encode(created)]);
}

/**
 * HOLDER: attach a REAL did-auth presentationProof to a SIGNED v0.4 manifest
 * (EXT-T1 §T1.2). The proof binds the exact signed bytes (signing-input hash)
 * to the verifier's challenge + audience + the created instant, signed by the
 * manifest signing key (DID Auth by the subject). Returns a NEW manifest; the
 * input is not mutated. The existing signature stays valid because
 * presentationProof is excluded from the signing input (Base §1.6.3).
 */
export async function attachPresentationProofDidAuth(signedManifest, privateKey, opts = {}) {
  if (!signedManifest || typeof signedManifest !== "object") {
    throw new Error("attachPresentationProofDidAuth: signed manifest object required");
  }
  if (!signedManifest.signature || !isNonEmptyString(signedManifest.signature.value)) {
    throw new Error("attachPresentationProofDidAuth: manifest must be SIGNED first (the validation binds the signed bytes)");
  }
  const challenge = opts.challenge;
  const audience = opts.audience;
  const created = isNonEmptyString(opts.created) ? opts.created : new Date().toISOString();
  if (!isNonEmptyString(challenge)) throw new Error("attachPresentationProofDidAuth: challenge required");
  if (!isNonEmptyString(audience)) throw new Error("attachPresentationProofDidAuth: audience required");

  const message = await didAuthProofMessage(signedManifest, { challenge, audience, created });
  const sig = await signBytes(message, privateKey);

  // Sanity: the signing key MUST be the manifest signing key (DID Auth is by the
  // subject; the verifier checks against signature.publicKeySpkiB64). Fail loudly
  // here rather than emit a proof that can never verify.
  const raw = await derivePublicKeyRaw(privateKey);
  const embedded = signedManifest.signature.publicKeySpkiB64;
  if (isNonEmptyString(embedded)) {
    const embeddedSpki = base64ToBytes(embedded);
    const oursSpki = rawPublicKeyToSpki(raw);
    if (bytesToHex(embeddedSpki) !== bytesToHex(oursSpki)) {
      throw new Error(
        "attachPresentationProofDidAuth: key is not the manifest signing key (signature.publicKeySpkiB64 mismatch)"
      );
    }
  }

  const validation = {
    proofType: "did-auth",
    challenge,
    audience,
    created,
    proofValue: bytesToBase64Url(sig),
  };
  const shape = validatePresentationProofShape(validation);
  if (!shape.valid) throw new Error(`attachPresentationProofDidAuth: ${shape.errors.join("; ")}`);
  return { ...signedManifest, presentationProof: validation };
}

/**
 * VERIFIER (demo surface): issue a fresh interactive challenge at the portal.
 * The nonce is cryptographically random and unique per presentation request
 * (EXT-T1 §T1.2 "MUST be unique per presentation request").
 * Returns { verifierChallenge, verifierAudience, issuedAt }.
 */
export function issueVerifierChallenge(opts = {}) {
  const audience = isNonEmptyString(opts.audience) ? opts.audience : "did:web:demo.local:world:destination";
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return {
    verifierChallenge: `um-challenge-${bytesToHex(bytes)}`,
    verifierAudience: audience,
    issuedAt: new Date().toISOString(),
  };
}

// ===========================================================================
// 3) EVALUATOR SIDE — Stage-2 sub-steps 2a/2b (EXT-T1 §T1.4)
// ===========================================================================

/**
 * Verify a did-auth presentationProof's crypto (EXT-T1 §T1.2). The verification
 * key is the manifest signing key — embedded signature.publicKeySpkiB64 first
 * (the suite posture), falling back to an offline-derivable keyRef (did:key).
 * Returns boolean; every failure path is CLOSED (false).
 */
export async function verifyDidAuthPresentationProof(manifest, validation) {
  try {
    const sig = manifest?.signature;
    let keyInput = null;
    if (sig && isNonEmptyString(sig.publicKeySpkiB64)) {
      keyInput = base64ToBytes(sig.publicKeySpkiB64);
    } else if (sig && isNonEmptyString(sig.keyRef)) {
      const resolved = await resolveKeyRefOffline(sig.keyRef);
      if (resolved.resolution === "resolved") keyInput = resolved.rawPublicKey;
    }
    if (!keyInput) return false; // no verifiable key ⇒ fail closed
    const message = await didAuthProofMessage(manifest, validation);
    return await verifyBytes(message, validation.proofValue, keyInput);
  } catch {
    return false;
  }
}

/**
 * Stage-2 sub-step 2b — presentation-proof verification (EXT-T1 §T1.4).
 * Mirrors the reference evaluator's check order EXACTLY:
 *   challenge issued + proof absent            ⇒ "missing-required" + reject
 *   proof.challenge ≠ verifierChallenge        ⇒ "failed" + reject   (replay-suspect)
 *   proof.audience  ≠ verifierAudience (set)   ⇒ "failed" + reject
 *   proofType "did-auth"                       ⇒ REAL crypto verify ⇒ "verified" | "failed"+reject
 *   proofType "sd-jwt-kb" / "bbs-derived"      ⇒ AT-RISK, FAIL CLOSED: "failed" + reject
 *   no challenge issued                        ⇒ status null (offline/cached display posture)
 * Returns { status, reject, rejectReason, warning }.
 */
export async function evaluatePresentationProof(manifest, context = {}) {
  const challengeIssued = isNonEmptyString(context.verifierChallenge);
  const validation = manifest?.presentationProof;
  if (!challengeIssued) {
    // No interactive challenge: a proof (or its absence) is not evaluated here;
    // the manifest is valid only for offline/cached display (EXT-T1 §T1.2).
    return { status: null, reject: false, rejectReason: null, warning: null };
  }
  if (!validation) {
    const reason =
      "presentationProof absent for a verifier-issued challenge — replay-suspect, rejected for interactive verification (EXT-T1 Section T1.2)";
    return {
      status: "missing-required",
      reject: true,
      rejectReason: reason,
      warning: { code: "um:reason:trust:presentation-validation-missing", message: `Verify stage (2b): ${reason}` },
    };
  }
  if (validation.challenge !== context.verifierChallenge) {
    const reason = "presentationProof.challenge does not match the verifier-issued nonce (EXT-T1 Section T1.4 sub-step 2b)";
    return {
      status: "failed",
      reject: true,
      rejectReason: reason,
      warning: { code: "um:reason:trust:presentation-validation-failed", message: `Verify stage (2b): ${reason}` },
    };
  }
  if (isNonEmptyString(context.verifierAudience) && validation.audience !== context.verifierAudience) {
    const reason = "presentationProof.audience does not match this verifier (EXT-T1 Section T1.4 sub-step 2b)";
    return {
      status: "failed",
      reject: true,
      rejectReason: reason,
      warning: { code: "um:reason:trust:presentation-validation-failed", message: `Verify stage (2b): ${reason}` },
    };
  }
  if (validation.proofType === "did-auth") {
    const ok = await verifyDidAuthPresentationProof(manifest, validation);
    if (ok) return { status: "verified", reject: false, rejectReason: null, warning: null };
    const reason =
      "presentationProof.proofValue does not validate over the signing-input hash, challenge, audience, and created (EXT-T1 Section T1.2)";
    return {
      status: "failed",
      reject: true,
      rejectReason: reason,
      warning: { code: "um:reason:trust:presentation-validation-failed", message: `Verify stage (2b): ${reason}` },
    };
  }
  // sd-jwt-kb / bbs-derived: AT-RISK (CONFORMANCE §9) — no crypto here, and an
  // unvalidatable proof MUST NOT be accepted for interactive verification.
  // FAIL CLOSED: "failed" + reject. NEVER "verified".
  const reason = `presentationProof.proofType "${validation.proofType}" is at-risk/unimplemented — failed closed for interactive verification (CONFORMANCE Section 9; EXT-T1 Section T1.4 sub-step 2b)`;
  return {
    status: "failed",
    reject: true,
    rejectReason: reason,
    warning: { code: "um:reason:trust:presentation-validation-failed", message: `Verify stage (2b): ${reason}` },
  };
}

/**
 * Resolve the reciprocal-control counterparty verification keys.
 *   subject side  — the manifest signing key (embedded SPKI first, else offline keyRef)
 *   boundDid side — offline-derivable DIDs only (did:key / did:pkh:solana)
 * Anything unresolvable returns null (⇒ fail closed upstream).
 */
async function reciprocalKeys(manifest, binding) {
  let subjectKey = null;
  const sig = manifest?.signature;
  if (sig && isNonEmptyString(sig.publicKeySpkiB64)) {
    try {
      subjectKey = base64ToBytes(sig.publicKeySpkiB64);
    } catch {
      subjectKey = null;
    }
  } else if (sig && isNonEmptyString(sig.keyRef)) {
    const r = await resolveKeyRefOffline(sig.keyRef);
    if (r.resolution === "resolved") subjectKey = r.rawPublicKey;
  }
  let boundKey = null;
  if (isNonEmptyString(binding.boundDid)) {
    try {
      const r = await resolveKeyRefOffline(binding.boundDid);
      if (r.resolution === "resolved") boundKey = r.rawPublicKey;
    } catch {
      boundKey = null;
    }
  }
  return { subjectKey, boundKey };
}

/**
 * Stage-2 sub-step 2a — holder-binding verification for ONE claim (EXT-T1
 * §T1.1.1). Returns { status, tier1Capable, reason }:
 *   status ∈ verified | failed | unsupported-mode | absent
 *   tier1Capable — whether this binding lets the claim be relied on at Tier 1+
 * Postures (the honesty ceiling, per mode):
 *   reciprocal-control — REAL Ed25519 verify of both proofs over UTF-8(manifest
 *     @id) when both keys resolve offline; unresolvable keys or failing
 *     signatures FAIL CLOSED (status "failed").
 *   sd-jwt-kb / bbs-holder-commitment — shape-checked, then "unsupported-mode":
 *     this evaluator has no SD-JWT/KB-JWT or BBS+ crypto, and a binding it
 *     cannot verify is NEVER "verified" (Tier-0 cap; fail closed).
 */
export async function verifyHolderBindingForClaim(manifest, claim) {
  const binding = claim?.holderBinding;
  if (binding === undefined) return { status: "absent", tier1Capable: false, reason: "claim carries no holderBinding" };

  const shape = validateHolderBindingShape(binding, claim["@type"]);
  if (!shape.valid) {
    return { status: "failed", tier1Capable: false, reason: shape.errors.join("; ") };
  }

  if (binding.mode === "reciprocal-control") {
    const manifestId = manifest?.["@id"];
    if (!isNonEmptyString(manifestId)) {
      return { status: "failed", tier1Capable: false, reason: "manifest @id missing — reciprocal challenge undefined" };
    }
    const { subjectKey, boundKey } = await reciprocalKeys(manifest, binding);
    if (!subjectKey || !boundKey) {
      return {
        status: "failed",
        tier1Capable: false,
        reason:
          "reciprocal-control keys not offline-resolvable (subject embedded key and/or boundDid) — cannot verify, failed closed (EXT-T1 Section T1.1.1)",
      };
    }

    // Dispatch: opt-in HARDENED profile (AV-5 fix) vs the literal spec T1.1.1 recipe.
    const hardened = binding.bindingProfile === RECIPROCAL_HARDENED_PROFILE;
    let messageBytes;
    if (hardened) {
      if (!isNonEmptyString(binding.nonce)) {
        return {
          status: "failed",
          tier1Capable: false,
          profile: "hardened",
          replayable: false,
          reason: `reciprocal-control hardened profile "${RECIPROCAL_HARDENED_PROFILE}" requires a nonce — absent, failed closed`,
        };
      }
      const subjectRaw = toRawEd25519PublicKey(subjectKey);
      let subjectDidKey = null;
      try {
        if (subjectRaw) subjectDidKey = publicKeyToDidKey(subjectRaw);
      } catch {
        subjectDidKey = null;
      }
      if (!subjectDidKey) {
        return {
          status: "failed",
          tier1Capable: false,
          profile: "hardened",
          replayable: false,
          reason: "reciprocal-control hardened: subject key not derivable to did:key — failed closed",
        };
      }
      // Bind the ACTUAL embedded subject identity + boundDid + fresh nonce + @id, so a
      // captured boundDidProof (committed to the victim's subject key) cannot transplant.
      messageBytes = buildReciprocalHardenedMessage({
        nonce: binding.nonce,
        subjectDidKey,
        boundDid: binding.boundDid,
        manifestId,
      });
    } else {
      // Literal EXT-T1 §T1.1.1: both proofs sign UTF-8(manifest @id). Verifies, but is
      // REPLAYABLE (AV-5) — evaluateHolderBindings flags it on the receipt so we never
      // silently overclaim a Tier-1 binding to a DID the presenter may not control.
      messageBytes = utf8Encode(manifestId);
    }

    let subjectOk = false;
    let boundOk = false;
    try {
      subjectOk = await verifyBytes(messageBytes, binding.subjectProof, subjectKey);
    } catch {
      subjectOk = false;
    }
    try {
      boundOk = await verifyBytes(messageBytes, binding.boundDidProof, boundKey);
    } catch {
      boundOk = false;
    }
    if (subjectOk && boundOk) {
      return hardened
        ? {
            status: "verified",
            tier1Capable: true,
            profile: "hardened",
            replayable: false,
            reason: `subjectProof + boundDidProof verify over the hardened reciprocal message (fresh nonce + both DIDs + @id) — replay-resistant (${RECIPROCAL_HARDENED_PROFILE})`,
          }
        : {
            status: "verified",
            tier1Capable: true,
            profile: "spec-t1.1.1",
            replayable: true,
            reason:
              "subjectProof + boundDidProof verify over the manifest @id (EXT-T1 §T1.1.1) — replay-vulnerable recipe; see the reciprocal-binding-replayable receipt warning",
          };
    }
    return {
      status: "failed",
      tier1Capable: false,
      profile: hardened ? "hardened" : "spec-t1.1.1",
      replayable: false,
      reason: `reciprocal-control validation verification failed (subjectProof ${subjectOk ? "ok" : "FAILED"}, boundDidProof ${boundOk ? "ok" : "FAILED"})${hardened ? ` [hardened profile ${RECIPROCAL_HARDENED_PROFILE}]` : ""} (EXT-T1 Section T1.1.1)`,
    };
  }

  // sd-jwt-kb / bbs-holder-commitment: structural shape passed, but this
  // evaluator implements NO crypto for these modes ⇒ "unsupported-mode",
  // never verified, Tier-0 cap (fail closed).
  return {
    status: "unsupported-mode",
    tier1Capable: false,
    reason: `holderBinding.mode "${binding.mode}" has no implemented verification profile in this evaluator — recorded unsupported-mode, capped at Tier 0 (EXT-T1 Section T1.1.1; fail closed)`,
  };
}

/**
 * Stage-2 sub-step 2a over ALL claims + the Tier-0 cap discipline (EXT-T1
 * §T1.0/§T1.1; Base §6.4.5 floors raise only). Feeds tier engine.
 * Returns { holderBindingStatus, claimStatuses, effectiveTrustTier, warnings }.
 * holderBindingStatus is the manifest-level roll-up: the FIRST non-verified
 * status encountered wins (failure-dominant), else "verified" when at least
 * one binding verified, else undefined (no bindings anywhere).
 */
export async function evaluateHolderBindings(manifest, context = {}) {
  const maxSupportedTier = Number.isInteger(context.maxSupportedTrustTier) ? context.maxSupportedTrustTier : 0;
  const manifestTier = Number.isInteger(manifest?.requiredTrustTier) ? manifest.requiredTrustTier : 0;
  const claims = Array.isArray(manifest?.claims) ? manifest.claims : [];
  const claimStatuses = [];
  const warnings = [];
  let holderBindingStatus;
  let effectiveTrustTier;

  const dominance = { failed: 3, "unsupported-mode": 2, absent: 1, verified: 0 };
  const roll = (s) => {
    if (holderBindingStatus === undefined || dominance[s] > dominance[holderBindingStatus]) holderBindingStatus = s;
  };

  for (const claim of claims) {
    if (!claim || typeof claim !== "object") continue;
    const claimRef = isNonEmptyString(claim["@id"]) ? claim["@id"] : claim["@type"];
    const claimTier = Math.max(manifestTier, Number.isInteger(claim.requiredTrustTier) ? claim.requiredTrustTier : 0);
    const carriesBindingMaterial =
      claim.holderBinding !== undefined || claim.bindingProof !== undefined || claim.ceremonyProof !== undefined;

    if (claimTier > maxSupportedTier && maxSupportedTier < 1) {
      // Section 6.4.5: no implemented verification profile for the required tier.
      claimStatuses.push({
        claimRef,
        status: "trustTierUnsupported",
        tier: maxSupportedTier,
        reason: `claim requiredTrustTier ${claimTier} exceeds evaluator capability ${maxSupportedTier} (Section 6.4.5)`,
      });
      continue;
    }

    if (claimTier >= 1 && !carriesBindingMaterial) {
      // T1.0/T1.1: Tier-1+ reliance with no binding material ⇒ Tier-0 cap.
      claimStatuses.push({
        claimRef,
        status: "trustTierUnsupported",
        tier: 0,
        reason: "claim relied upon at Tier 1+ carries no holderBinding — capped at Tier 0 (EXT-T1 Section T1.1)",
      });
      roll("absent");
      effectiveTrustTier = 0;
      warnings.push({
        code: "um:reason:trust:unbound-claims",
        message: `claim ${claimRef}: relied upon at Tier ${claimTier} without holder binding — capped at Tier 0 (EXT-T1 Section T1.1)`,
      });
      continue;
    }

    if (claim.holderBinding !== undefined) {
      const r = await verifyHolderBindingForClaim(manifest, claim);
      roll(r.status);
      if (r.status === "verified") {
        const grantedTier = Math.min(claimTier, Math.max(maxSupportedTier, 1));
        claimStatuses.push({ claimRef, status: "bound", tier: grantedTier, reason: r.reason });
        effectiveTrustTier = effectiveTrustTier === undefined ? grantedTier : Math.max(effectiveTrustTier, grantedTier);
        if (r.replayable === true) {
          // AV-5 honesty: the binding verified under the literal EXT-T1 §T1.1.1 recipe,
          // which is replay-vulnerable. Stay conformant ("verified") but DISCLOSE it —
          // never a silent Tier-0→Tier-1 overclaim. The opt-in hardened profile
          // (RECIPROCAL_HARDENED_PROFILE) resists the transplant/replay.
          warnings.push({
            code: RECIPROCAL_REPLAYABLE_WARNING_CODE,
            message: `claim ${claimRef}: reciprocal holder-binding verified per EXT-T1 §T1.1.1 but this recipe is replay-vulnerable (both validation sign only the manifest @id — no nonce/counterparty/content binding); a published boundDidProof can transplant to a DID the presenter may not control. Finding filed to the UM spec; use bindingProfile "${RECIPROCAL_HARDENED_PROFILE}" for a replay-resistant binding.`,
          });
        }
      } else {
        claimStatuses.push({
          claimRef,
          status: claimTier >= 1 ? "trustTierUnsupported" : "unverified",
          tier: 0,
          reason: r.reason,
        });
        effectiveTrustTier = 0;
        warnings.push({
          code:
            r.status === "unsupported-mode"
              ? "um:reason:trust:binding-mode-unsupported"
              : "um:reason:trust:binding-failed",
          message: `claim ${claimRef}: ${r.reason}`,
        });
      }
      continue;
    }

    // Tier-0 claim without a binding: present, nothing to verify here.
    claimStatuses.push({
      claimRef,
      status: "unverified",
      tier: 0,
      reason: "Tier-0 claim without holderBinding (binding not required below Tier 1)",
    });
  }

  return { holderBindingStatus, claimStatuses, effectiveTrustTier, warnings };
}

/**
 * keyRefResolution posture (Base §1.6.4): resolve signature.keyRef through the
 * OFFLINE ladder only (did:key / did:pkh:solana; injected-loader did:web).
 * Everything else records "unresolved" — and keyRef-DERIVED identity is capped
 * at Tier 0 (the embedded key still verifies bytes; it just cannot elevate
 * identity assurance). This mirrors the reference evaluator + suite posture.
 */
export async function recordKeyRefResolution(manifest, opts = {}) {
  const keyRef = manifest?.signature?.keyRef;
  if (!isNonEmptyString(keyRef)) return "unresolved";
  try {
    const r = await resolveKeyRefOffline(keyRef, opts);
    return r.resolution === "resolved" ? "resolved" : "unresolved";
  } catch {
    return "unresolved";
  }
}

// ===========================================================================
// 4) SCOPE EVALUATION — enough of the Verify stage to decide the four
//    evaluation-mode fixtures (and the demo's interactive crossing check).
//    NOT the full six-stage engine.
// ===========================================================================

/** Minimal envelope checks shared by both surfaces (v0.4 Base §1.2/§1.3). */
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
  if (isIsoDateTime(manifest.issuedAt) && isIsoDateTime(manifest.expiresAt) && Date.parse(manifest.issuedAt) > Date.parse(manifest.expiresAt)) {
    errors.push("issuedAt must be <= expiresAt");
  }
  return errors;
}

/**
 * STRUCTURAL verdict for a fixture (clock-independent; no receipt):
 * envelope basics → shapes (holder binding / presentation proof / VP
 * limits) → Profile A signature over the v0.4 signing input.
 * Returns { result: "accept"|"reject", reasons: string[] , checks: {...} }.
 */
export async function structuralVerdictHolderBinding(manifest) {
  const reasons = [];
  reasons.push(...envelopeErrors(manifest));
  const runtime = validateHolderBindingStructural(manifest);
  reasons.push(...runtime.errors);
  let sigReport = null;
  if (reasons.length === 0) {
    // Signature LAST: shape defects report their own reason, not a crypto one.
    sigReport = await verifyManifestProfileA(manifest);
    if (!sigReport.ok) reasons.push(`signature verification failed: ${sigReport.reason}`);
  }
  return {
    result: reasons.length === 0 ? "accept" : "reject",
    reasons,
    checks: { signature: sigReport ? sigReport.reason : "not-evaluated" },
  };
}

/**
 * EVALUATION verdict for a fixture: the Verify-stage slice this change owns,
 * executed at the pinned evaluationContext (never the wall clock):
 *   Arrive/Verify structural+signature → freshness (60s skew) → keyRefResolution
 *   → sub-step 2b presentationProof → sub-step 2a holder bindings → outcome.
 * Returns { result, receipt } where receipt carries the fields expected.json
 * asserts (outcome, signatureCheck, freshnessCheck, keyRefResolution,
 * presentationProofStatus?, holderBindingStatus?, claimStatuses?, warnings).
 */
export async function evaluateHolderBinding(manifest, context = {}) {
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
    warnings,
  };
  const finish = (outcome) => {
    receipt.outcome = outcome;
    return { result: outcome === "rejected" ? "reject" : "accept", receipt };
  };

  // --- Arrive/Verify: structure + shapes + signature -----------------
  const envErrors = envelopeErrors(manifest);
  const shapeErrors = envErrors.length === 0 ? validateHolderBindingStructural(manifest).errors : [];
  if (envErrors.length > 0 || shapeErrors.length > 0) {
    warnings.push({ code: "um:reason:structure:malformed", message: `Verify stage: ${[...envErrors, ...shapeErrors].join("; ")}` });
    return finish("rejected");
  }
  const sig = manifest.signature;
  if (!sig || typeof sig !== "object") {
    warnings.push({ code: "um:reason:crypto:signature-missing", message: "Verify stage: missing signature" });
    return finish("rejected");
  }
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

  // keyRefResolution (Base §1.6.4): offline ladder posture; unresolved ⇒ the
  // keyRef-derived identity is capped at Tier 0. This is a RECORDED POSTURE,
  // not a warning (the reference evaluator records the field silently and the
  // suite's valid presentation fixture is outcome "accepted", not
  // "accepted-with-warnings" — the cap is expressed by the field itself).
  receipt.keyRefResolution = await recordKeyRefResolution(manifest);

  // --- Freshness at the PINNED now (Section 3.1.2; 60s skew) ----------------
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

  // --- Sub-step 2b: presentation proof (EXT-T1 §T1.4) -----------------------
  const pp = await evaluatePresentationProof(manifest, context);
  if (pp.status !== null) receipt.presentationProofStatus = pp.status;
  if (pp.reject) {
    warnings.unshift(pp.warning);
    return finish("rejected");
  }

  // --- Sub-step 2a: holder bindings + Tier-0 caps (EXT-T1 §T1.1) ------------
  const hb = await evaluateHolderBindings(manifest, context);
  if (hb.holderBindingStatus !== undefined) receipt.holderBindingStatus = hb.holderBindingStatus;
  if (hb.effectiveTrustTier !== undefined) receipt.effectiveTrustTier = hb.effectiveTrustTier;
  if (hb.claimStatuses.length > 0) receipt.claimStatuses = hb.claimStatuses;
  warnings.push(...hb.warnings);

  // --- Compose the outcome ---------------------------------------------------
  const anyCapped = hb.claimStatuses.some((c) => c.status === "trustTierUnsupported" || c.status === "unverified");
  if (anyCapped) return finish("accepted-partial");
  if (warnings.length > 0) return finish("accepted-with-warnings");
  return finish("accepted");
}

// ===========================================================================
// 5) DEMO SURFACE — the interactive crossing exchange (challenge → proof →
//    receipt), including the replay-reject toggle. Pure functions; the UI
//    wiring into live-adapter.js is the a serialized edit.
// ===========================================================================

/**
 * End-to-end interactive presentation for the portal crossing demo:
 *   1. destination world issues a challenge (issueVerifierChallenge)
 *   2. the visitor's SIGNED manifest gets a did-auth presentationProof
 *   3. the destination evaluates: challenge+audience match + REAL Ed25519 verify
 *   4. the replay toggle re-evaluates under a DIFFERENT challenge ⇒ rejected
 * Returns { challenge, presented, receiptVerified, receiptReplay } — the two
 * receipts carry presentationProofStatus "verified" and "failed" respectively.
 */
export async function demoPresentationExchange(signedManifest, privateKey, opts = {}) {
  const challenge = issueVerifierChallenge({ audience: opts.audience });
  const presented = await attachPresentationProofDidAuth(signedManifest, privateKey, {
    challenge: challenge.verifierChallenge,
    audience: challenge.verifierAudience,
  });
  const evalContext = {
    now: new Date().toISOString(),
    maxSupportedTrustTier: Number.isInteger(opts.maxSupportedTrustTier) ? opts.maxSupportedTrustTier : 1,
    verifierChallenge: challenge.verifierChallenge,
    verifierAudience: challenge.verifierAudience,
  };
  const receiptVerified = (await evaluateHolderBinding(presented, evalContext)).receipt;
  // Replay toggle: the SAME presented manifest against a FRESH challenge — the
  // proof binds the old nonce, so the evaluator must reject (replay-suspect).
  const replayChallenge = issueVerifierChallenge({ audience: challenge.verifierAudience });
  const receiptReplay = (
    await evaluateHolderBinding(presented, { ...evalContext, verifierChallenge: replayChallenge.verifierChallenge })
  ).receipt;
  return { challenge, presented, receiptVerified, receiptReplay };
}

// ===========================================================================
// 6) CONFORMANCE-RUNNER REGISTRATION HOOK (the shared v0.4 runner wires this
//    with ONE line — applied by the integration step, not by this module).
// ===========================================================================

/** The 12 fixture files owns (11 named by the task + G2 oversize-vp). */
export const feature_FIXTURE_FILENAMES = Object.freeze([
  "valid/manifest-with-holder-binding.jsonld",
  "valid/manifest-with-bbs-holder-binding.jsonld",
  "valid/manifest-with-reciprocal-holder-binding.jsonld",
  "invalid/holder-binding-invalid-mode.jsonld",
  "invalid/holder-binding-missing-cnf.jsonld",
  "invalid/holder-binding-reciprocal-missing-fields.jsonld",
  "invalid/holder-binding-bbs-missing-commitment.jsonld",
  "valid/manifest-with-presentation-validation.jsonld",
  "invalid/presentation-validation-challenge-mismatch.jsonld",
  "invalid/presentation-validation-audience-mismatch.jsonld",
  "invalid/presentation-validation-missing-when-challenged.jsonld",
  "invalid/claim-validation-oversize-vp.jsonld",
]);

/**
 * Evaluate ONE fixture against its expected.json entry contract:
 *   entry.validationMode "evaluation" ⇒ evaluateHolderBinding under entry.evaluationContext
 *   otherwise                         ⇒ structuralVerdictHolderBinding (clock-independent)
 * Returns { result: "accept"|"reject", reason, receipt? } — the adapter shape
 * the runner pattern uses (adapter.mjs), so the shared v0.4 runner can
 * dispatch fixtures to this handler with no impedance mismatch.
 */
export async function featureFixtureHandler(fixtureJson, expectedEntry = {}) {
  if (expectedEntry.validationMode === "evaluation") {
    const { result, receipt } = await evaluateHolderBinding(fixtureJson, expectedEntry.evaluationContext || {});
    return {
      result,
      reason: receipt.warnings?.[0]?.message || receipt.outcome,
      receipt,
    };
  }
  const verdict = await structuralVerdictHolderBinding(fixtureJson);
  return { result: verdict.result, reason: verdict.reasons.join("; ") || "structural contract satisfied" };
}

/**
 * Registration hook for the shared v0.4 conformance runner. Contract:
 *   registry.register(filename, asyncHandler(fixtureJson, expectedEntry))
 * The orchestrator wires it with exactly:
 *   import { registerHolderBinding } from "../manifest/holder-binding.mjs";
 *   registerHolderBinding(registry);
 */
export function registerHolderBinding(registry) {
  if (!registry || typeof registry.register !== "function") {
    throw new Error("registerHolderBinding: registry with a register(filename, handler) function required");
  }
  for (const filename of feature_FIXTURE_FILENAMES) {
    registry.register(filename, featureFixtureHandler);
  }
  return feature_FIXTURE_FILENAMES.length;
}
