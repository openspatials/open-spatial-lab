// UM Signature Profile A binding (Ed25519 + JCS-RFC8785).
//
// Implements the signing-input and signature-shape rules of the Universal Manifest
// Signature Profile (universalmanifest spec/v0.2/SIGNATURE-PROFILE.md — carried
// forward UNCHANGED through v0.3 and v0.4; v0.4 CONFORMANCE.md line "Signature
// profile (unchanged from v0.2)"):
//
//   SIGNING INPUT (§4, normative):
//     1. Start with the manifest JSON object.
//     2. Remove the `signature` property entirely (never included — circularity).
//        v0.4 (Base Section 1.6.3) additionally removes `presentationProof` and
//        `postQuantumSignature` when present.
//     3. JCS-canonicalize (RFC 8785) -> UTF-8 bytes.
//     4. Ed25519-sign those bytes.
//
//   SIGNATURE SHAPE (§3):
//     signature.algorithm         MUST be "Ed25519"
//     signature.canonicalization  MUST be "JCS-RFC8785"
//     signature.keyRef            URI of key material (we default to a did:key URL,
//                                 which makes it OFFLINE-RESOLVABLE and therefore
//                                 consistency-checkable)
//     signature.publicKeySpkiB64  base64 SPKI DER public key (the suite's
//                                 embedded-key escape hatch — every UM fixture
//                                 carries it; embedding is our default too)
//     signature.created           ISO 8601 (recommended)
//     signature.value             base64url Ed25519 signature (no padding)
//
//   VERIFIER LADDER (checklist §5 steps 3–6 + v0.3+ Section 1.6.4):
//     - enforce the profile pair (algorithm + canonicalization) — unknown pairs are
//       NEVER reinterpreted as the baseline profile (§5.1);
//     - obtain the key: embedded publicKeySpkiB64 is FIRST-CLASS (the UM
//       conformance suite performs no DID dereferencing — conformance/README.md:
//       "DID key resolution is deliberately out of scope"); a caller-supplied
//       didOrKey overrides; otherwise a did:key keyRef is derived offline;
//     - keyRef ↔ embedded-key CONSISTENCY: when keyRef is offline-derivable
//       (did:key / did:pkh:solana) AND a key is embedded, the two MUST match
//       (key-substitution mitigation). Non-derivable refs (did:example, did:web
//       without a loader) record keyRefResolution:"unresolved" and the embedded
//       key stands — the reference evaluator's exact posture;
//     - recompute the signing input and verify Ed25519 over the canonical bytes.
//
//   INPUT DISCIPLINE (adversarial-hardening follow-up, HARDENING-signing.md;
//   the JCS + Ed25519 core is UNCHANGED — these are guards IN FRONT of it):
//     - B1: the verifier REJECTS (reason invalid-signing-input:…) any document whose
//       signing input carries a number outside ±(2^53-1) — such a double aliases
//       distinct JSON texts under one signature (opt out: opts.strictNumbers=false;
//       opt-in on the sign side via the same option). Parse untrusted manifest TEXT
//       with parseIJson (./ijson.mjs) to reject the range violation at the door.
//     - B2: parseIJson also rejects DUPLICATE object keys (RFC 7493 §2.3), which
//       JSON.parse silently collapses last-wins into one canonical form.
//     - B3: a PRESENT non-string manifestVersion is REJECTED by the verifier
//       (reason invalid-manifest-version-type) — it would silently select a
//       different exclusion set than a spec verifier / the emitter. The exclusion
//       gate itself is a VALIDATED version test (string "0.4"), matching the
//       emitter's stripForSigning.
//
// HONEST SCOPE (what this module does NOT claim):
//   - Verifier checklist steps 1–2 (envelope shape, @type um:Manifest, TTL
//     enforcement) belong to the MANIFEST CONSUMER, not the crypto library; the
//     demo integration owns them. verifyManifestProfileA checks the
//     SIGNATURE, and reports exactly which checks it ran.
//   - Producing a signature "shaped for Profile A" is proven by test vectors and
//     by cross-checking against the UM reference implementation — NOT by flipping
//     any conformance flag. No *_conformance flag is set anywhere in this change.

import { jcsCanonicalize, jcsCanonicalizeToBytes } from "./jcs-rfc8785.mjs";
import {
  derivePublicKeyRaw,
  importPrivateKey,
  publicKeyInputToRaw,
  rawPublicKeyToSpki,
  signBytes,
  spkiToRawPublicKey,
  verifyBytes,
} from "./ed25519.mjs";
import { base64ToBytes, bytesEqual, bytesToBase64, bytesToBase64Url } from "./codecs.mjs";
import { checkKeyRefConsistency, publicKeyToDidKey, resolveKeyRefOffline } from "./did.mjs";
// Adversarial-hardening follow-up (HARDENING-signing.md B1): I-JSON number
// discipline in front of the (unchanged) JCS + Ed25519 core.
import { findUnsafeNumber } from "./ijson.mjs";

export const PROFILE_A = Object.freeze({
  algorithm: "Ed25519",
  canonicalization: "JCS-RFC8785",
});

// Machine-readable scoped-claim descriptor (pattern: web/geopose-basic-sdu.mjs).
// Consumed by the result report and any future UI label — the same scoped truth
// everywhere. Every `true` below is backed by a vector in verify-vectors.mjs.
export const SIGNING_CONFORMANCE = Object.freeze({
  standard: "Universal Manifest Signature Profile A (spec/v0.2/SIGNATURE-PROFILE.md; unchanged through v0.4)",
  jcs_rfc8785_reference_vectors_byte_exact: true, // RFC 8785 §3.2.3/§3.2.4 bytes + Appendix B + sorting vector
  ed25519_rfc8032_vectors_byte_exact: true, // RFC 8032 §7.1 TEST 1/2/3 sign+verify, deterministic bytes
  profile_a_signature_shape: true, // required members, base64url value, base64 SPKI, signing-input rule
  keyref_embedded_key_consistency_check: true, // v0.3+ Section 1.6.4 ladder implemented + vectored
  did_key_offline_derivation: true, // did:key <-> raw key round-trip, spec example decode
  did_web_live_resolution: false, // OUT OF SCOPE — injected-loader stub only (suite posture)
  did_pkh_nonsolana_key_derivation: false, // impossible by construction (addresses are key hashes)
  signed_live_manifest: false, // THIS TASK IS THE LIBRARY ONLY — live signing/integration is
  scoped_claim:
    "Proven signing LIBRARY: byte-exact RFC 8785 JCS + RFC 8032 Ed25519 + Profile A shape " +
    "against test vectors and the UM reference verifier; NOT yet a signed live manifest.",
});

/**
 * The v0.4 (Base 1.6.3) signing-input exclusion set, gated on a VALIDATED version:
 * the exclusion applies exactly when `manifestVersion` is the STRING "0.4".
 * (Hardening B3: a NON-string version — e.g. the number 0.4 — previously slipped
 * past the strict-equality gate and silently disabled the exclusion, diverging
 * from spec verifiers and from the emitter's stripForSigning. It is now REJECTED
 * by the verifier — see verifyDetailed — instead of silently changing the signed
 * byte set. The gate stays version-VALUE-aware, not unconditional, because the
 * v0.3 back-compat path (version-routing.mjs) depends on v0.3 signing
 * input being manifest − signature only; the emitter's stripForSigning is
 * aligned to this same validated gate.)
 */
function signingExclusions(manifest, opts) {
  return (
    opts.exclude ??
    (typeof manifest.manifestVersion === "string" && manifest.manifestVersion === "0.4"
      ? ["presentationProof", "postQuantumSignature"]
      : [])
  );
}

/** Shared unsigned-object builder for computeSigningInput / computeSigningInputString. */
function buildUnsignedSigningObject(manifest, opts) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Signing input requires a JSON object manifest");
  }
  const unsigned = { ...manifest };
  delete unsigned.signature;
  for (const k of signingExclusions(manifest, opts)) delete unsigned[k];
  // Hardening B1 (opt-in here; the VERIFIER enforces it by default): numbers outside
  // ±(2^53-1) alias distinct JSON texts onto one double (RFC 7493 §2.2), so a strict
  // caller refuses to build a signing input over them. Kept opt-in on the SIGN side
  // for back-compat with programmatic callers; string-encode big numbers instead
  // (RFC 8785 Appendix D).
  if (opts.strictNumbers) {
    const unsafe = findUnsafeNumber(unsigned);
    if (unsafe) {
      throw new TypeError(
        `I-JSON: number ${unsafe.value} at ${unsafe.path} is outside the safe range ±(2^53-1); ` +
          "represent big numbers as strings (RFC 8785 Appendix D)"
      );
    }
  }
  return unsigned;
}

/**
 * Compute the Profile A signing input (canonical UTF-8 bytes) for a manifest.
 * Removes `signature` always; for manifestVersion "0.4" (validated string; or
 * opts.exclude) also removes `presentationProof` / `postQuantumSignature` per
 * Base Section 1.6.3. Pass opts.strictNumbers to reject numbers outside ±(2^53-1).
 */
export function computeSigningInput(manifest, opts = {}) {
  return jcsCanonicalizeToBytes(buildUnsignedSigningObject(manifest, opts));
}

/** Same as computeSigningInput but returns the canonical STRING (debug/vector display). */
export function computeSigningInputString(manifest, opts = {}) {
  return jcsCanonicalize(buildUnsignedSigningObject(manifest, opts));
}

/**
 * Sign an object per Profile A. Returns { signature, protected }:
 *   signature — base64url Ed25519 signature string (the `signature.value` payload)
 *   protected — the profile metadata block: { algorithm, canonicalization, keyRef,
 *               publicKeySpkiB64?, created } (spread it into a manifest `signature`
 *               member together with `value` — attachSignatureProfileA does this).
 * Options:
 *   keyRef          default: did:key DID URL derived from the signing key
 *   embedPublicKey  default true — sets publicKeySpkiB64 (suite escape hatch)
 *   created         default: new Date().toISOString(); pass null to omit
 *   exclude         extra top-level members to exclude from the signing input
 */
export async function sign(obj, privateKeyInput, opts = {}) {
  const privateKey = await importPrivateKey(privateKeyInput);
  const rawPublicKey = await derivePublicKeyRaw(privateKey);
  const spki = rawPublicKeyToSpki(rawPublicKey);

  const didKey = publicKeyToDidKey(rawPublicKey);
  const keyRef = opts.keyRef ?? `${didKey}#${didKey.slice("did:key:".length)}`;
  const created = opts.created === null ? undefined : opts.created ?? new Date().toISOString();
  const embed = opts.embedPublicKey !== false;

  const payload = computeSigningInput(obj, opts);
  const sigBytes = await signBytes(payload, privateKey);

  const protectedBlock = {
    algorithm: PROFILE_A.algorithm,
    canonicalization: PROFILE_A.canonicalization,
    keyRef,
    ...(created !== undefined ? { created } : {}),
    ...(embed ? { publicKeySpkiB64: bytesToBase64(spki) } : {}),
  };

  return { signature: bytesToBase64Url(sigBytes), protected: protectedBlock };
}

/**
 * Sign a manifest and return a NEW manifest carrying the Profile A `signature`
 * member (input object is not mutated). This is the issuer-side one-call shape.
 */
export async function attachSignatureProfileA(manifest, privateKeyInput, opts = {}) {
  const { signature, protected: prot } = await sign(manifest, privateKeyInput, opts);
  return { ...manifest, signature: { ...prot, value: signature } };
}

/**
 * Verify per Profile A. Returns boolean.
 *   obj        — the object/manifest (an existing `signature` member is excluded
 *                from the signing input per §4; v0.4 exclusions auto-apply)
 *   signature  — base64url string, OR a full signature object
 *                ({ algorithm, canonicalization, value, keyRef?, publicKeySpkiB64? })
 *   didOrKey   — optional: DID/DID-URL string (did:key / did:pkh:solana offline;
 *                did:web only with opts.documentLoader), raw/SPKI bytes, base64
 *                string, JWK, or CryptoKey. When omitted, a signature OBJECT must
 *                carry publicKeySpkiB64 (with keyRef consistency enforced) or an
 *                offline-derivable keyRef.
 * For the detailed check report use verifyManifestProfileA.
 */
export async function verify(obj, signature, didOrKey, opts = {}) {
  const report = await verifyDetailed(obj, signature, didOrKey, opts);
  return report.ok;
}

/**
 * Verify a manifest whose `signature` member is attached (consumer-side one-call
 * shape). Returns the detailed check report { ok, reason, checks:{...} }.
 */
export async function verifyManifestProfileA(manifest, opts = {}) {
  if (!manifest || typeof manifest !== "object" || !manifest.signature || typeof manifest.signature !== "object") {
    return { ok: false, reason: "missing-signature", checks: {} };
  }
  return verifyDetailed(manifest, manifest.signature, opts.didOrKey, opts);
}

async function verifyDetailed(obj, signature, didOrKey, opts = {}) {
  const checks = {
    profilePair: false,
    signingInputRecomputed: false,
    keySource: "none",
    keyRefResolution: "unresolved",
    keyRefConsistency: "not-applicable",
    ed25519Verified: false,
  };

  // Normalize the signature argument.
  let sigValue;
  let sigObject = null;
  if (typeof signature === "string") {
    sigValue = signature;
  } else if (signature && typeof signature === "object") {
    sigObject = signature;
    // §5.1: the algorithm+canonicalization pair IS the profile identity; unknown
    // pairs MUST NOT be reinterpreted as the baseline profile.
    if (sigObject.algorithm !== PROFILE_A.algorithm || sigObject.canonicalization !== PROFILE_A.canonicalization) {
      return { ok: false, reason: "unsupported-profile", checks };
    }
    if (typeof sigObject.value !== "string" || sigObject.value.length === 0) {
      return { ok: false, reason: "missing-signature-value", checks };
    }
    sigValue = sigObject.value;
  } else {
    return { ok: false, reason: "missing-signature", checks };
  }
  checks.profilePair = true; // bare-string form: caller asserts Profile A explicitly

  // Input discipline (hardening B3): the signing-input exclusion set is derived
  // from manifestVersion, so a NON-string version (e.g. the number 0.4) would
  // silently select a different signed byte set than a spec verifier / the
  // emitter. Fail CLOSED instead of diverging. Absent manifestVersion stays
  // valid (plain signed objects / pre-v0.4 shapes carry none).
  if (
    obj &&
    typeof obj === "object" &&
    Object.prototype.hasOwnProperty.call(obj, "manifestVersion") &&
    typeof obj.manifestVersion !== "string"
  ) {
    return { ok: false, reason: "invalid-manifest-version-type", checks };
  }

  // Obtain the verification key (ladder; embedded key is first-class per the suite).
  let publicKeyInput = null;
  const embedded = sigObject && typeof sigObject.publicKeySpkiB64 === "string" ? sigObject.publicKeySpkiB64 : null;
  const keyRef = sigObject && typeof sigObject.keyRef === "string" ? sigObject.keyRef : null;

  if (didOrKey !== undefined && didOrKey !== null) {
    if (typeof didOrKey === "string" && didOrKey.startsWith("did:")) {
      const resolved = await resolveKeyRefOffline(didOrKey, opts);
      if (resolved.resolution !== "resolved") {
        return { ok: false, reason: `did-not-offline-resolvable:${resolved.method}`, checks };
      }
      checks.keyRefResolution = "resolved";
      publicKeyInput = resolved.rawPublicKey;
      checks.keySource = "caller-did";
    } else {
      publicKeyInput = didOrKey;
      checks.keySource = "caller-key";
    }
    // Even with a caller key, an embedded key must not contradict it silently.
    if (embedded) {
      const embeddedRaw = spkiToRawPublicKey(base64ToBytes(embedded));
      let callerRaw;
      try {
        callerRaw = publicKeyInputToRaw(publicKeyInput);
      } catch {
        callerRaw = null; // CryptoKey — comparison happens implicitly via verification
      }
      if (callerRaw && !bytesEqual(callerRaw, embeddedRaw)) {
        checks.keyRefConsistency = "mismatch";
        return { ok: false, reason: "caller-key-embedded-key-mismatch", checks };
      }
    }
  } else if (embedded) {
    publicKeyInput = base64ToBytes(embedded); // 44-byte SPKI
    checks.keySource = "embedded-spki";
    if (keyRef) {
      const consistency = await checkKeyRefConsistency(keyRef, publicKeyInput, opts);
      checks.keyRefResolution = consistency.keyRefResolution;
      checks.keyRefConsistency = consistency.keyRefResolution === "resolved" ? (consistency.consistent ? "consistent" : "mismatch") : "unresolved-embedded-key-stands";
      if (!consistency.consistent) {
        return { ok: false, reason: "keyref-embedded-key-mismatch", checks }; // Section 1.6.4
      }
    }
  } else if (keyRef) {
    const resolved = await resolveKeyRefOffline(keyRef, opts);
    checks.keyRefResolution = resolved.resolution;
    if (resolved.resolution !== "resolved") {
      // conformance fixture invalid/signature-keyref-without-embedded-key.jsonld:
      // unresolvable ref + no embedded key = cannot verify = reject.
      return { ok: false, reason: "keyref-unresolvable-and-no-embedded-key", checks };
    }
    publicKeyInput = resolved.rawPublicKey;
    checks.keySource = "keyref-derived";
  } else {
    return { ok: false, reason: "no-key-material", checks };
  }

  // Recompute signing input (§4 / v0.4 Base 1.6.3) and verify. Hardening B1:
  // strict I-JSON numbers are ENFORCED here by default (opt out with
  // opts.strictNumbers === false) — a document carrying a number outside
  // ±(2^53-1) aliases other JSON texts under the same canonical bytes, so a
  // signature over it is never accepted. Any signing-input failure (including
  // a non-object manifest or non-JSON data) is normalized to a fail-CLOSED
  // report instead of a throw.
  let payload;
  try {
    payload = computeSigningInput(obj, { ...opts, strictNumbers: opts.strictNumbers !== false });
  } catch (e) {
    return { ok: false, reason: `invalid-signing-input:${(e && e.message) || "error"}`, checks };
  }
  checks.signingInputRecomputed = true;

  let ok = false;
  try {
    ok = await verifyBytes(payload, sigValue, publicKeyInput);
  } catch {
    ok = false;
  }
  checks.ed25519Verified = ok;
  return { ok, reason: ok ? "verified" : "signature-verification-failed", checks };
}
