// v0.4 encrypted/sealed JWE facet subsystem: emit (REAL
// 5-field JWE crypto), sealed-entry consume, malformed-reject (fail closed),
// isolation smoke (Q1, Grade-1 structural).
//
// This module is the Base §2.3/§2.4 owner for the demo:
//   emit      — seal facet entities as REAL JWE General JSON Serialization
//               objects (RFC 7516) under encryptionProfile "jwe-inline-v1",
//               using the Base §2.4.1 MUST-implement baseline algorithm pair
//               ECDH-ES+A256KW (key management) + A256GCM (content encryption).
//   consume   — Stage-4 sealed-entry contract (Base §3.1.4 / CONFORMANCE §2.7):
//               an encrypted facet without a decryption key is acknowledged as
//               a SEALED ENTRY — facet status "opaque", outcome
//               "accepted-partial" — NEVER rejected solely for being
//               undecryptable. With a key: REAL decrypt and process.
//   reject    — structural conformance (Base §2.3.2 / CONFORMANCE §6.6): a JWE
//               missing ANY of the five members (protected, recipients, iv,
//               ciphertext, tag) is malformed — FAIL CLOSED.
//   isolation — Q1 per-facet isolation shape (Base §2.3.5 PREVIEW): distinct
//               recipients[].header.kid AND distinct iv across the declared
//               set. Grade-1 structural: this "tests JSON-Schema shape, not
//               the cryptographic isolation property" (expected.json wording).
//
// Spec sources (READ-ONLY, ):
//   spec/v0.4/schema.json            $defs.facet (jwe-inline-v1 conditional) +
//                                    $defs.jweEntity (5 required members)
//   spec/v0.4/CONFORMANCE.md         §2.7 (sealed entry), §3.6 (holder emit),
//                                    §6.6 (malformed-JWE structural reject)
//   docs/spec-v0.4/core.html         Base §2.3.1–2.3.5, §2.4.1–2.4.3, §3.1.4
//   conformance/v0.4/expected.json   the 4 fixture entries this change owns
//
// ---------------------------------------------------------------------------
// HONESTY CEILING — what is REAL vs structural/PREVIEW (machine-readable
// descriptor: feature_CONFORMANCE below; every `real:true` is exercised by
// web/manifest/verify.mjs against the external suite or live crypto):
//   REAL   JWE emit + decrypt        — WebCrypto ECDH-ES (P-256) + Concat KDF
//                                      (RFC 7518 §4.6.2, SHA-256) + AES-KW CEK
//                                      wrap + A256GCM with AAD = protected
//                                      header (RFC 7516 §5.1). Round-trips.
//   REAL   sealed-entry evaluation   — no key ⇒ "opaque" + accepted-partial;
//                                      with key ⇒ real decrypt ⇒ "processed".
//   REAL   fail-closed decrypt       — GCM tag failure / wrong key / unwrap
//                                      failure ⇒ facet stays sealed ("opaque",
//                                      reason "decryption failed") — plaintext
//                                      is NEVER partially exposed.
//   REAL   malformed-JWE reject      — any of the 5 members missing/empty ⇒
//                                      structural reject (schema-detectable).
//   CLOSED unsupported algorithm pair— a JWE declaring a pair other than the
//                                      §2.4.1 baseline ⇒ SEALED ENTRY (present
//                                      but not read, §2.4.2) even when a key
//                                      for the kid is held — never decrypted,
//                                      never rejected for that alone.
//   SHAPE  Q1 per-facet isolation    — distinct-kid + distinct-iv cross-field
//          (PREVIEW, Grade-1)          check only. Echoing expected.json: it
//                                      "tests JSON-Schema shape, not the
//                                      cryptographic isolation property".
//                                      Distinct kid/iv are NECESSARY but not
//                                      sufficient for true key isolation
//                                      (Base §2.3.5 residual gap). The demo's
//                                      OWN two sealed facets do use genuinely
//                                      independent P-256 recipient keys, but
//                                      that is a property of the demo's key
//                                      custody, not something the manifest
//                                      bytes can attest.
// This module flips NO um_conformance flag. Scope: the 4 fixtures + the
// P6 crossing receipt surface. NOT the consent engine, NOT the full
// private-data family — write consent / unlock windows / key-lifecycle events
//NOT the full six-stage evaluator.
// ---------------------------------------------------------------------------
//
// FILE DISCIPLINE: this is a NEW, specific module. It imports only the
// signing library (read-only reuse) and is imported by nothing yet.
// Registration into the shared v0.4 conformance runner is via registerWo132()
// (see the hook section at the bottom) — one wiring block, applied by the
// integration step, not by this module. Browser + Node (>= 18.4),
// WebCrypto only, zero dependencies.

import { verifyManifestProfileA } from "../signing/um-signature-profile-a.mjs";
import { base64UrlToBytes, bytesToBase64Url, utf8Decode, utf8Encode } from "../signing/codecs.mjs";

// ===========================================================================
// Constants (schema.json $defs.jweEntity + Base §2.3/§2.4 value sets)
// ===========================================================================

/** The one registered inline-encryption profile (Base §2.3.1). */
export const JWE_ENCRYPTION_PROFILE = "jwe-inline-v1";

/** Base §2.4.1 — the MUST-implement baseline algorithm pair. */
export const JWE_BASELINE_ALG = "ECDH-ES+A256KW";
export const JWE_BASELINE_ENC = "A256GCM";

/** The five required JWE General JSON Serialization members (Base §2.3.2 / schema $defs.jweEntity). */
export const JWE_REQUIRED_MEMBERS = Object.freeze(["protected", "recipients", "iv", "ciphertext", "tag"]);

/**
 * The exact protected header this module emits. Byte-identical to the suite
 * fixtures' `protected` value (base64url of {"alg":"ECDH-ES+A256KW","enc":"A256GCM"}).
 * Per-recipient parameters (kid, epk) live in recipients[].header (RFC 7516
 * General JSON Serialization), so the protected header carries only the pair.
 */
export const JWE_BASELINE_PROTECTED_B64U = "eyJhbGciOiJFQ0RILUVTK0EyNTZLVyIsImVuYyI6IkEyNTZHQ00ifQ";

// Machine-readable scoped-claim descriptor (pattern: feature_CONFORMANCE /
// SIGNING_CONFORMANCE). Every `true` is backed by verify.mjs output.
export const feature_CONFORMANCE = Object.freeze({
  wo: "runtime",
  standard:
    "Universal Manifest v0.4 Base §2.3 (JWE inline encrypted facets) + §2.4 (algorithm constraints) + §3.1.4 (sealed entry)",
  fixtures_owned: 4,
  baseline_algorithm_pair: `${JWE_BASELINE_ALG} / ${JWE_BASELINE_ENC}`, // Base §2.4.1 — read, not guessed
  // REAL crypto surfaces:
  jwe_emit_real: true, // WebCrypto ECDH-ES(P-256)+ConcatKDF+AES-KW+A256GCM, AAD = protected header
  jwe_decrypt_real: true, // holder-key round-trip; GCM tag enforced
  sealed_entry_evaluation_real: true, // no key ⇒ "opaque" + accepted-partial (never rejected for that)
  malformed_jwe_fail_closed: true, // any of the 5 members missing ⇒ structural reject
  decrypt_failure_fail_closed: true, // tamper/wrong key ⇒ facet stays sealed; plaintext never partially exposed
  unsupported_alg_pair_sealed: true, // non-baseline declared pair ⇒ sealed entry (§2.4.2), never decrypted
  // Structural / PREVIEW surfaces (never claimed beyond shape):
  q1_isolation_structural_only: true, // "tests JSON-Schema shape, not the cryptographic isolation property"
  key_management_demo_local: true, // static demo recipient keys; NO KMS / custody claims
  consent_engine: false,
  private_data_family: false, // write consent / unlock windows / key lifecycle —
  full_six_stage_evaluator: false, // composes; this is the encrypted-facet Stage-4 slice
  um_conformance_flag_flipped: false,
  scoped_claim:
    "runtime implements REAL JWE emit/decrypt for encrypted facets (ECDH-ES+A256KW / A256GCM, the Base " +
    "§2.4.1 baseline pair; RFC 7516 General JSON Serialization; AAD = protected header), the REAL " +
    "sealed-entry evaluation contract (no key ⇒ 'opaque' + accepted-partial, never rejected solely for " +
    "undecryptability), and fail-closed structural rejection of malformed JWEs. The Q1 isolation check is " +
    "Grade-1 structural — it tests JSON-Schema shape (distinct kid, distinct iv), not the cryptographic " +
    "isolation property. Demo-local static recipient keys; no KMS claims. This is the encrypted-facet " +
    "slice, not the full six-stage evaluator.",
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
function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) unavailable — need Node >= 18.4 or a modern browser");
  return s;
}
function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
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
function uint32be(n) {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

// ===========================================================================
// 1) STRUCTURAL SURFACE — schema.json $defs parity (fail closed)
// ===========================================================================

/**
 * Validate a jweEntity per schema.json $defs.jweEntity (Base §2.3.2 /
 * CONFORMANCE §6.6): the five members `protected`, `recipients`, `iv`,
 * `ciphertext`, `tag` are ALL required (strings non-empty; recipients a
 * non-empty array — see below — whose every element carries header.kid).
 *
 * DEFENSE-IN-DEPTH (deliberately STRICTER than the reference schema): schema.json
 * $defs.jweEntity sets NO `minItems` on `recipients`, so a zero-recipient JWE is
 * schema-valid. This validator additionally enforces `recipients.length >= 1` and
 * fails closed on an EMPTY recipients array: a sealed entry with no recipient entry
 * is unreadable by construction (no kid, no wrapped CEK) and therefore
 * useless/suspect. This is a labeled demo-hardening check, not a schema requirement.
 *
 * Optional key-lifecycle fields (previousKid / rotationReason /
 * revokedRecipientKid / revocationAction) are display metadata — validated as
 * strings when present, never required (their processing semantics are).
 * Returns { valid, errors: string[] }.
 */
export function validateJweEntityShape(entity) {
  const errors = [];
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    return { valid: false, errors: ["entity must be a JWE General JSON Serialization object (Base 2.3.2)"] };
  }
  const missing = JWE_REQUIRED_MEMBERS.filter((m) => entity[m] === undefined);
  if (missing.length > 0) {
    errors.push(`JWE missing required member(s): ${missing.join(", ")} (all five required — Base 2.3.2 / CONFORMANCE 6.6)`);
  }
  for (const m of ["protected", "iv", "ciphertext", "tag"]) {
    if (entity[m] !== undefined && !isNonEmptyString(entity[m])) {
      errors.push(`JWE member "${m}" must be a non-empty string`);
    }
  }
  if (entity.recipients !== undefined) {
    if (!Array.isArray(entity.recipients)) {
      errors.push('JWE member "recipients" must be an array');
    } else {
      // DEFENSE-IN-DEPTH (stricter than schema.json $defs.jweEntity, which sets no
      // minItems): reject an EMPTY recipients array — a sealed entry with zero
      // recipients is unreadable/useless (no kid, no wrapped CEK). Fail closed.
      if (entity.recipients.length < 1) {
        errors.push(
          'JWE member "recipients" must contain at least one recipient entry ' +
            "(demo defense-in-depth: stricter than schema $defs.jweEntity, which sets no minItems — " +
            "a sealed entry with zero recipients is unreadable/suspect)"
        );
      }
      entity.recipients.forEach((r, i) => {
        if (!r || typeof r !== "object" || Array.isArray(r)) {
          errors.push(`recipients[${i}] must be an object`);
          return;
        }
        if (!r.header || typeof r.header !== "object" || Array.isArray(r.header)) {
          errors.push(`recipients[${i}].header is required (schema $defs.jweEntity)`);
        } else if (!isNonEmptyString(r.header.kid)) {
          errors.push(`recipients[${i}].header.kid is required and must be a non-empty string`);
        }
        if (r.encrypted_key !== undefined && typeof r.encrypted_key !== "string") {
          errors.push(`recipients[${i}].encrypted_key must be a string when present`);
        }
      });
    }
  }
  for (const opt of ["previousKid", "rotationReason", "revokedRecipientKid", "revocationAction"]) {
    if (entity[opt] !== undefined && typeof entity[opt] !== "string") {
      errors.push(`JWE optional member "${opt}" must be a string when present`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate the encrypted facets of a manifest per the schema.json $defs.facet
 * conditional: `encryptionProfile: "jwe-inline-v1"` ⇒ `entity` is REQUIRED and
 * MUST be a valid jweEntity. Any other encryptionProfile value fails the
 * schema const. Non-encrypted facets are NOT this change's surface and are left
 * alone. Returns { valid, errors, encryptedFacets: [{index, facetId, entity}] }.
 */
export function validateSealedFacetsStructural(manifest) {
  const errors = [];
  const encryptedFacets = [];
  const facets = manifest && Array.isArray(manifest.facets) ? manifest.facets : [];
  facets.forEach((facet, index) => {
    if (!facet || typeof facet !== "object") return;
    if (facet.encryptionProfile === undefined) return;
    const label = isNonEmptyString(facet["@id"]) ? facet["@id"] : `facets[${index}]`;
    if (facet.encryptionProfile !== JWE_ENCRYPTION_PROFILE) {
      errors.push(`${label}: encryptionProfile must be the const "${JWE_ENCRYPTION_PROFILE}" (schema $defs.facet)`);
      return;
    }
    if (facet.entity === undefined) {
      errors.push(`${label}: entity is REQUIRED when encryptionProfile is "${JWE_ENCRYPTION_PROFILE}" (schema $defs.facet conditional)`);
      return;
    }
    const shape = validateJweEntityShape(facet.entity);
    if (!shape.valid) {
      errors.push(...shape.errors.map((e) => `${label}: ${e}`));
      return;
    }
    encryptedFacets.push({ index, facetId: facet["@id"], entity: facet.entity });
  });
  return { valid: errors.length === 0, errors, encryptedFacets };
}

/**
 * Q1 per-facet isolation shape (Base §2.3.5 PREVIEW — Grade-1 STRUCTURAL):
 * across the declared set of encrypted facets, every recipients[].header.kid
 * MUST be distinct facet-to-facet and every iv MUST be distinct (IV reuse
 * under a shared CEK is catastrophic for A256GCM). This is a cross-field
 * structural rule of the same kind as the trust-tier floor check (§6.4.5).
 *
 * HONESTY (echoed from the suite's own expected.json wording): this check
 * "tests JSON-Schema shape, not the cryptographic isolation property".
 * Distinct kid strings and distinct iv values are NECESSARY but NOT
 * SUFFICIENT for true key isolation — two distinct kids can still name
 * derived children of one root secret, which manifest bytes cannot attest.
 *
 * @param manifest       the manifest whose encrypted facets form the set
 * @param declaredSetIds OPTIONAL facet-@id allowlist for the declared set
 *                       (default: ALL encrypted facets in the manifest)
 * Returns { valid, errors, grade: "structural-shape-only", note }.
 */
export function checkIsolationShape(manifest, declaredSetIds = null) {
  const errors = [];
  const { encryptedFacets, errors: shapeErrors } = validateSealedFacetsStructural(manifest);
  if (shapeErrors.length > 0) {
    // Malformed JWEs are their own reject; the isolation comparison needs shape-valid members.
    errors.push(...shapeErrors);
  }
  const inSet = declaredSetIds
    ? encryptedFacets.filter((f) => declaredSetIds.includes(f.facetId))
    : encryptedFacets;
  const kidOwner = new Map(); // kid -> facetId
  const ivOwner = new Map(); // iv  -> facetId
  for (const f of inSet) {
    for (const r of f.entity.recipients) {
      const kid = r?.header?.kid;
      if (!isNonEmptyString(kid)) continue;
      const owner = kidOwner.get(kid);
      if (owner !== undefined && owner !== f.facetId) {
        errors.push(
          `isolation violation: recipients[].header.kid "${kid}" is shared by facets ${owner} and ${f.facetId} (Base 2.3.5: no shared recipient key entry)`
        );
      } else {
        kidOwner.set(kid, f.facetId);
      }
    }
    const iv = f.entity.iv;
    if (isNonEmptyString(iv)) {
      const owner = ivOwner.get(iv);
      if (owner !== undefined && owner !== f.facetId) {
        errors.push(
          `isolation violation: iv "${iv}" is reused by facets ${owner} and ${f.facetId} (Base 2.3.5: IV reuse under a shared CEK is catastrophic for A256GCM)`
        );
      } else {
        ivOwner.set(iv, f.facetId);
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    setSize: inSet.length,
    grade: "structural-shape-only",
    note: "Q1 tests JSON-Schema shape, not the cryptographic isolation property (distinct kid/iv are necessary, not sufficient — Base 2.3.5 residual gap)",
  };
}

// ===========================================================================
// 2) REAL JWE CRYPTO — WebCrypto only, zero deps (browser + Node >= 18.4)
//    ECDH-ES (P-256) + Concat KDF (RFC 7518 §4.6.2, SHA-256) → AES-KW KEK →
//    wraps a fresh A256GCM CEK; AAD = ASCII(protected b64u) (RFC 7516 §5.1).
// ===========================================================================

/** Decode a JWE protected header (base64url JSON). Returns object or null (never throws). */
export function decodeProtectedHeader(protectedB64u) {
  try {
    const obj = JSON.parse(utf8Decode(base64UrlToBytes(protectedB64u)));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Concat KDF (NIST SP 800-56A one-step, as profiled by RFC 7518 §4.6.2) with
 * SHA-256. For ECDH-ES+A256KW the derived KEK is 256 bits — exactly one hash
 * round: SHA-256( uint32be(1) || Z || AlgorithmID || PartyUInfo || PartyVInfo
 * || SuppPubInfo ), where AlgorithmID is the length-prefixed UTF-8 "alg" value
 * (key-agreement-with-key-wrapping mode), apu/apv default empty, and
 * SuppPubInfo is uint32be(keydatalen).
 */
async function concatKdfSha256(z, algorithmId, keyDataLenBits) {
  const algBytes = utf8Encode(algorithmId);
  const otherInfo = concatBytes([
    uint32be(algBytes.length),
    algBytes,
    uint32be(0), // PartyUInfo (apu) — empty
    uint32be(0), // PartyVInfo (apv) — empty
    uint32be(keyDataLenBits), // SuppPubInfo
  ]);
  const input = concatBytes([uint32be(1), z, otherInfo]);
  const digest = new Uint8Array(await subtle().digest("SHA-256", input));
  return digest.slice(0, keyDataLenBits / 8);
}

/** Reduce a JWK to its public EC members (what goes on the wire as epk). */
function publicEcJwk(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/**
 * Generate a demo-local static recipient key pair (ECDH P-256) identified by
 * `kid`. Key management stays DEMO-LOCAL (static keys held in memory); no KMS
 * or custody claims. Returns { kid, publicJwk, privateKey, publicKey }.
 */
export async function generateRecipientKeyPair(kid) {
  if (!isNonEmptyString(kid)) throw new Error("generateRecipientKeyPair: non-empty kid required");
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicJwk = publicEcJwk(await subtle().exportKey("jwk", pair.publicKey));
  return { kid, publicJwk, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

async function importEcPublicJwk(jwk) {
  return subtle().importKey("jwk", publicEcJwk(jwk), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

/** ECDH(P-256) shared secret Z between a private CryptoKey and a public CryptoKey. */
async function ecdhZ(privateKey, publicKey) {
  return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
}

async function importKek(kekBytes, usages) {
  return subtle().importKey("raw", kekBytes, "AES-KW", false, usages);
}

/**
 * REAL JWE encryption (RFC 7516 General JSON Serialization) under the Base
 * §2.4.1 baseline pair. The plaintext is the JSON serialization of the
 * facet's um:Entity payload (Base §2.3.2).
 *
 *   - one fresh 256-bit A256GCM CEK per JWE
 *   - one fresh 96-bit iv per JWE (never reused — see checkIsolationShape)
 *   - per recipient: fresh ephemeral P-256 pair → ECDH-ES Z → Concat KDF
 *     (AlgorithmID "ECDH-ES+A256KW") → 256-bit KEK → AES-KW wrap of the CEK;
 *     the recipient's unprotected header carries { kid, epk }
 *   - AAD = ASCII(BASE64URL(UTF8(protected))) (RFC 7516 §5.1 step 14)
 *
 * @param entityPayload  JSON-serializable um:Entity payload (the plaintext)
 * @param recipients     [{ kid, publicJwk | publicKey }] — 1..n designated readers
 * @returns the 5-member jweEntity object (schema $defs.jweEntity valid)
 */
export async function encryptJweForRecipients(entityPayload, recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("encryptJweForRecipients: at least one recipient { kid, publicJwk } required");
  }
  const protectedB64u = JWE_BASELINE_PROTECTED_B64U;
  const aad = utf8Encode(protectedB64u); // ASCII of the b64u string
  const iv = randomBytes(12); // 96-bit GCM nonce, fresh per JWE

  // Fresh CEK (extractable ONLY so AES-KW can wrap it; never exported elsewhere).
  const cek = await subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

  const plaintext = utf8Encode(JSON.stringify(entityPayload));
  const sealed = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, cek, plaintext)
  );
  const ciphertext = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);

  const recipientEntries = [];
  for (const r of recipients) {
    if (!isNonEmptyString(r?.kid)) throw new Error("encryptJweForRecipients: every recipient needs a kid");
    const staticPublic = r.publicKey || (await importEcPublicJwk(r.publicJwk));
    // Fresh ephemeral pair PER RECIPIENT (ECDH-ES+A256KW multi-recipient shape).
    const ephemeral = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const z = await ecdhZ(ephemeral.privateKey, staticPublic);
    const kekBytes = await concatKdfSha256(z, JWE_BASELINE_ALG, 256);
    const kek = await importKek(kekBytes, ["wrapKey"]);
    const wrapped = new Uint8Array(await subtle().wrapKey("raw", cek, kek, "AES-KW"));
    const epk = publicEcJwk(await subtle().exportKey("jwk", ephemeral.publicKey));
    recipientEntries.push({
      header: { kid: r.kid, epk },
      encrypted_key: bytesToBase64Url(wrapped),
    });
  }

  return {
    protected: protectedB64u,
    recipients: recipientEntries,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext),
    tag: bytesToBase64Url(tag),
  };
}

/**
 * REAL JWE decryption with a holder/recipient key. FAIL CLOSED: any failure —
 * unknown kid, non-baseline pair (§2.4.2), missing epk, AES-KW unwrap failure,
 * GCM tag mismatch (tamper) — throws; plaintext is never partially exposed.
 * Returns the parsed um:Entity payload.
 */
export async function decryptJweWithKey(jweEntity, { kid, privateKey }) {
  const shape = validateJweEntityShape(jweEntity);
  if (!shape.valid) throw new Error(`decrypt refused — malformed JWE: ${shape.errors[0]}`);
  const header = decodeProtectedHeader(jweEntity.protected);
  if (!header) throw new Error("decrypt refused — protected header is not base64url JSON");
  if (header.alg !== JWE_BASELINE_ALG || header.enc !== JWE_BASELINE_ENC) {
    throw new Error(
      `decrypt refused — algorithm pair ${header.alg}/${header.enc} is not the supported baseline ${JWE_BASELINE_ALG}/${JWE_BASELINE_ENC} (Base 2.4.2: treat as sealed entry)`
    );
  }
  const recipient = jweEntity.recipients.find((r) => r?.header?.kid === kid);
  if (!recipient) throw new Error(`decrypt refused — no recipient entry for kid "${kid}"`);
  if (!recipient.header.epk) throw new Error("decrypt refused — recipient header carries no epk (ephemeral public key)");
  if (!isNonEmptyString(recipient.encrypted_key)) {
    throw new Error("decrypt refused — recipient entry carries no encrypted_key");
  }

  const epk = await importEcPublicJwk(recipient.header.epk);
  const z = await ecdhZ(privateKey, epk);
  const kekBytes = await concatKdfSha256(z, JWE_BASELINE_ALG, 256);
  const kek = await importKek(kekBytes, ["unwrapKey"]);
  const cek = await subtle().unwrapKey(
    "raw",
    base64UrlToBytes(recipient.encrypted_key),
    kek,
    "AES-KW",
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const aad = utf8Encode(jweEntity.protected);
  const sealed = concatBytes([base64UrlToBytes(jweEntity.ciphertext), base64UrlToBytes(jweEntity.tag)]);
  const plaintext = new Uint8Array(
    await subtle().decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(jweEntity.iv), additionalData: aad, tagLength: 128 },
      cek,
      sealed
    )
  );
  return JSON.parse(utf8Decode(plaintext));
}

/**
 * Seal a facet: REAL-encrypt the entity payload for the designated recipients
 * and return a v0.4 facet object (schema $defs.facet, jwe-inline-v1 branch).
 * The facet keeps its plaintext @id/@type/name so consent matching and receipt
 * recording operate normally (Base §2.3.1); the sensitive content is confined
 * to the JWE.
 */
export async function makeSealedFacet({ facetId, name, entityPayload, recipients }) {
  if (!isNonEmptyString(facetId)) throw new Error("makeSealedFacet: facetId required");
  const entity = await encryptJweForRecipients(entityPayload, recipients);
  return {
    "@id": facetId,
    "@type": "um:Facet",
    ...(isNonEmptyString(name) ? { name } : {}),
    encryptionProfile: JWE_ENCRYPTION_PROFILE,
    entity,
  };
}

// ===========================================================================
// 3) EVALUATOR SURFACE — the encrypted-facet Stage-4 slice (Base §3.1.4)
// ===========================================================================

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
 * Evaluate the encrypted facets of a manifest against a (possibly empty)
 * keyring — the Base §3.1.4 sealed-entry contract:
 *   - key held + baseline pair + REAL decrypt succeeds ⇒ status "processed"
 *     (plaintext returned in `decrypted`, NEVER placed on the receipt)
 *   - no key for any recipient kid                      ⇒ SEALED ENTRY:
 *     status "opaque", reason "no decryption key" — never a rejection
 *   - declared pair is not the §2.4.1 baseline          ⇒ SEALED ENTRY
 *     (§2.4.2 — even when a key for the kid is held)
 *   - key held but decrypt FAILS (tamper/wrong key)     ⇒ FAIL CLOSED:
 *     status "opaque", reason "decryption failed" — plaintext never exposed
 *
 * @param manifest v0.4 manifest (structurally valid encrypted facets)
 * @param keyring  [{ kid, privateKey }] — the evaluator's decryption keys
 * Returns { facetStatuses: [{facetId, name?, status, reason?}], decrypted: Map, sealedCount }.
 */
export async function evaluateSealedFacets(manifest, keyring = []) {
  const facetStatuses = [];
  const decrypted = new Map();
  let sealedCount = 0;
  const facets = Array.isArray(manifest?.facets) ? manifest.facets : [];
  for (const facet of facets) {
    if (!facet || typeof facet !== "object" || facet.encryptionProfile !== JWE_ENCRYPTION_PROFILE) continue;
    const facetId = isNonEmptyString(facet["@id"]) ? facet["@id"] : "(missing @id)";
    const base = { facetId, ...(isNonEmptyString(facet.name) ? { name: facet.name } : {}) };

    const header = decodeProtectedHeader(facet.entity?.protected);
    const baselinePair = header && header.alg === JWE_BASELINE_ALG && header.enc === JWE_BASELINE_ENC;
    if (!baselinePair) {
      // §2.4.2: an unsupported (or unreadable) declared pair is a SEALED ENTRY —
      // present but not read, exactly as a facet for which no key is held.
      sealedCount += 1;
      facetStatuses.push({
        ...base,
        status: "opaque",
        reason: header
          ? `unsupported algorithm pair ${header.alg}/${header.enc} — sealed entry (Base 2.4.2)`
          : "unreadable protected header — sealed entry (present, not read)",
      });
      continue;
    }

    const kids = (facet.entity.recipients || []).map((r) => r?.header?.kid).filter(isNonEmptyString);
    const key = keyring.find((k) => kids.includes(k.kid));
    if (!key) {
      // Base §3.1.4 / CONFORMANCE §2.7: sealed entry — acknowledged as present,
      // recorded "opaque", NEVER rejected solely for being undecryptable.
      sealedCount += 1;
      facetStatuses.push({ ...base, status: "opaque", reason: "no decryption key" });
      continue;
    }
    try {
      const payload = await decryptJweWithKey(facet.entity, key);
      decrypted.set(facetId, payload);
      facetStatuses.push({ ...base, status: "processed" });
    } catch (e) {
      // FAIL CLOSED: a held key that cannot decrypt (tamper, wrong key, unwrap
      // failure) leaves the facet SEALED. Plaintext is never partially exposed.
      sealedCount += 1;
      facetStatuses.push({
        ...base,
        status: "opaque",
        reason: `decryption failed — fail closed (present, not read): ${e.message}`,
      });
    }
  }
  return { facetStatuses, decrypted, sealedCount };
}

/**
 * STRUCTURAL verdict for a fixture (clock-independent; no receipt):
 * envelope basics → encrypted-facet shape (5-field JWE, fail closed) → Q1
 * isolation shape across the manifest's encrypted set → Profile A signature
 * LAST, so shape defects report their own reason.
 * Returns { result: "accept"|"reject", reasons: string[], checks: {...} }.
 */
export async function structuralVerdictWo132(manifest, opts = {}) {
  const reasons = [];
  reasons.push(...envelopeErrors(manifest));
  const sealed = validateSealedFacetsStructural(manifest);
  reasons.push(...sealed.errors);
  let isolation = null;
  if (sealed.valid && sealed.encryptedFacets.length >= 2) {
    isolation = checkIsolationShape(manifest, opts.declaredSetIds ?? null);
    reasons.push(...isolation.errors);
  }
  let sigReport = null;
  if (reasons.length === 0) {
    sigReport = await verifyManifestProfileA(manifest);
    if (!sigReport.ok) reasons.push(`signature verification failed: ${sigReport.reason}`);
  }
  return {
    result: reasons.length === 0 ? "accept" : "reject",
    reasons,
    checks: {
      encryptedFacets: sealed.encryptedFacets.length,
      isolation: isolation ? { valid: isolation.valid, grade: isolation.grade } : "n/a (fewer than 2 encrypted facets)",
      signature: sigReport ? sigReport.reason : "not-evaluated",
    },
  };
}

/**
 * EVALUATION verdict for a fixture — the encrypted-facet slice of the
 * six-stage sequence, executed at the PINNED evaluationContext (never the wall
 * clock): Arrive (envelope + JWE shape, fail closed) → Verify (Profile A
 * signature + freshness, 60s skew) → Stage-4 sealed-entry/decrypt → Compose
 * (any sealed facet ⇒ accepted-partial) → Receipt.
 *
 * facetStatuses records the ENCRYPTED facets (this change's surface). Plaintext-
 * facet consent/projection statuses are; the manifest-level tier
 * gate is; the full composition is.
 *
 * context: { now, decryptionKeys?: [{kid, privateKey}], omitProcessedAt? }
 * Returns { result: "accept"|"reject", receipt, decrypted: Map }.
 */
export async function evaluateWo132(manifest, context = {}) {
  const nowMs = isIsoDateTime(context.now) ? Date.parse(context.now) : Date.now();
  const manifestId =
    manifest && typeof manifest === "object" && isNonEmptyString(manifest["@id"]) ? manifest["@id"] : "(unknown)";
  const warnings = [];
  const receipt = {
    "@type": "um:Receipt",
    manifestId,
    outcome: "rejected",
    signatureCheck: "not-evaluated",
    freshnessCheck: "not-evaluated",
    // EVAL-18 posture: this slice resolves no status endpoints — report "unchecked".
    revocationStatus: "unchecked",
    facetStatuses: [],
    warnings,
  };
  if (!context.omitProcessedAt) receipt.processedAt = new Date(nowMs).toISOString();
  const finish = (outcome) => {
    receipt.outcome = outcome;
    return { result: outcome === "rejected" ? "reject" : "accept", receipt, decrypted: receipt._decrypted || new Map() };
  };

  // --- Arrive: envelope + encrypted-facet structure (malformed JWE ⇒ FAIL CLOSED) ---
  const envErrors = envelopeErrors(manifest);
  const sealedShape = envErrors.length === 0 ? validateSealedFacetsStructural(manifest) : { errors: [] };
  if (envErrors.length > 0 || sealedShape.errors.length > 0) {
    warnings.push({
      code: "um:reason:structure:malformed",
      message: `Arrive stage: ${[...envErrors, ...sealedShape.errors].join("; ")}`,
    });
    return finish("rejected");
  }

  // --- Verify: Profile A signature over the v0.4 signing input --------------
  const sig = manifest.signature;
  if (!sig || typeof sig !== "object") {
    warnings.push({ code: "um:reason:crypto:signature-missing", message: "Verify stage: missing signature" });
    return finish("rejected");
  }
  const sigReport = await verifyManifestProfileA(manifest);
  if (!sigReport.ok) {
    receipt.signatureCheck = sigReport.reason === "unsupported-profile" ? "unsupported-profile" : "invalid";
    warnings.push({
      code:
        sigReport.reason === "unsupported-profile"
          ? "um:reason:crypto:unsupported-profile"
          : "um:reason:crypto:signature-invalid",
      message: `Verify stage: ${sigReport.reason}`,
    });
    return finish("rejected");
  }
  receipt.signatureCheck = "valid";

  // --- Freshness at the PINNED now (Section 3.1.2; 60s skew) ----------------
  const SKEW_MS = 60_000;
  if (Date.parse(manifest.issuedAt) - nowMs > SKEW_MS) {
    receipt.freshnessCheck = "stale";
    warnings.push({ code: "um:reason:freshness:stale", message: "Verify stage: issuedAt more than 60s in the future" });
    return finish("rejected");
  }
  if (nowMs > Date.parse(manifest.expiresAt)) {
    receipt.freshnessCheck = "expired";
    warnings.push({ code: "um:reason:freshness:expired", message: "Verify stage: manifest expired" });
    return finish("rejected");
  }
  receipt.freshnessCheck = "fresh";

  // --- Stage 4 (encrypted-facet slice): sealed entries / real decrypt -------
  const evalOut = await evaluateSealedFacets(manifest, context.decryptionKeys || []);
  receipt.facetStatuses = evalOut.facetStatuses;
  Object.defineProperty(receipt, "_decrypted", { value: evalOut.decrypted, enumerable: false });

  // --- Compose: sealed entries degrade to accepted-partial, NEVER rejected --
  const hasSealed = evalOut.sealedCount > 0;
  if (hasSealed) return finish("accepted-partial");
  if (warnings.length > 0) return finish("accepted-with-warnings");
  return finish("accepted");
}

// ===========================================================================
// 4) DEMO SURFACE — P6: "government ID + full birth date present but opaque"
//    (portaling page bar P6; receipt rows "sealed entry / opaque")
// ===========================================================================

/** The demo's two sealed-facet identities (P6). DISTINCT kids per facet (Q1). */
export const P6_GOVERNMENT_ID_FACET = Object.freeze({
  facetId: "urn:um:facet:government-id",
  name: "governmentId",
  label: "government ID",
  kid: "did:web:demo.local:civic-registry#key-agree-gov-id-1",
});
export const P6_BIRTH_DATE_FACET = Object.freeze({
  facetId: "urn:um:facet:full-birth-date",
  name: "fullBirthDate",
  label: "full birth date",
  kid: "did:web:demo.local:records-office#key-agree-birth-1",
});

/**
 * Build the crossing manifest's two sealed facets with REAL JWE crypto:
 * government-ID and full-birth-date, each sealed to its OWN demo recipient
 * key (distinct recipients[].header.kid values) and — by construction, one
 * fresh CEK + fresh 96-bit iv per JWE — distinct ivs: the Q1 isolation shape.
 * The payloads are FICTIONAL demo data (no real PII).
 *
 * Returns { facets: [govFacet, birthFacet], holderKeys: [{kid, privateKey}],
 *           isolationNote } — holderKeys stay DEMO-LOCAL (Base: no KMS claims).
 */
export async function buildSealedCrossingFacets(opts = {}) {
  const govRecipient = await generateRecipientKeyPair(P6_GOVERNMENT_ID_FACET.kid);
  const birthRecipient = await generateRecipientKeyPair(P6_BIRTH_DATE_FACET.kid);

  const govFacet = await makeSealedFacet({
    facetId: P6_GOVERNMENT_ID_FACET.facetId,
    name: P6_GOVERNMENT_ID_FACET.name,
    entityPayload: {
      "@type": "um:Entity",
      documentType: "government-id",
      idNumber: opts.idNumber || "DEMO-ID-4711-0042",
      issuingAuthority: "Demo Civic Registry (fictional)",
      note: "fictional demo payload — no real PII",
    },
    recipients: [govRecipient],
  });
  const birthFacet = await makeSealedFacet({
    facetId: P6_BIRTH_DATE_FACET.facetId,
    name: P6_BIRTH_DATE_FACET.name,
    entityPayload: {
      "@type": "um:Entity",
      documentType: "birth-record",
      fullBirthDate: opts.fullBirthDate || "1990-04-12",
      note: "fictional demo payload — no real PII",
    },
    recipients: [birthRecipient],
  });

  return {
    facets: [govFacet, birthFacet],
    holderKeys: [
      { kid: govRecipient.kid, privateKey: govRecipient.privateKey },
      { kid: birthRecipient.kid, privateKey: birthRecipient.privateKey },
    ],
    isolationNote:
      "distinct recipients[].header.kid + distinct iv per facet (Q1 shape — structural; " +
      "the demo's recipient keys are independently generated P-256 pairs, but the manifest " +
      "bytes attest only the shape, not the key-custody property)",
  };
}

/**
 * The P6 receipt rows, exactly as the portaling page's receipt table shows
 * them: `facet / government ID → sealed entry / opaque`. Derived from REAL
 * facetStatuses (evaluateSealedFacets/evaluateWo132 output), never invented:
 * only facets whose status is "opaque" render as sealed entries.
 */
export function p6ReceiptRows(facetStatuses) {
  const labelFor = (fs) => {
    if (fs.facetId === P6_GOVERNMENT_ID_FACET.facetId) return P6_GOVERNMENT_ID_FACET.label;
    if (fs.facetId === P6_BIRTH_DATE_FACET.facetId) return P6_BIRTH_DATE_FACET.label;
    return fs.name || fs.facetId;
  };
  return (facetStatuses || [])
    .filter((fs) => fs.status === "opaque" || fs.status === "processed")
    .map((fs) => ({
      row: `facet / ${labelFor(fs)}`,
      entry: fs.status === "opaque" ? "sealed entry" : "decrypted (holder key)",
      status: fs.status,
      display: `facet / ${labelFor(fs)} → ${fs.status === "opaque" ? "sealed entry / opaque" : "decrypted / processed"}`,
    }));
}

/**
 * The whole P6 demo surface in one call (what live-adapter.js attaches as
 * packet.avatar_context.um_sealed_facets_v04 — see the wiring lines in the
 * result artifact). Builds the two REAL sealed facets, evaluates them WITHOUT
 * keys (destination-evaluator posture ⇒ both rows "sealed entry / opaque"),
 * then proves the holder-key round-trip on the holder side.
 */
export async function demoSealedFacetSurface() {
  const { facets, holderKeys, isolationNote } = await buildSealedCrossingFacets();
  const manifestish = { facets };

  // Destination evaluator: NO keys ⇒ both facets are sealed entries.
  const noKeys = await evaluateSealedFacets(manifestish, []);
  const rows = p6ReceiptRows(noKeys.facetStatuses);

  // Holder side: the demo-local keys decrypt their OWN facet (round-trip proof).
  const withKeys = await evaluateSealedFacets(manifestish, holderKeys);
  const roundTrip = withKeys.facetStatuses.every((fs) => fs.status === "processed");

  return {
    standard: "Universal Manifest v0.4 Base 2.3 (JWE inline) / 3.1.4 (sealed entry)",
    algorithm_pair: `${JWE_BASELINE_ALG} / ${JWE_BASELINE_ENC} (Base 2.4.1 baseline)`,
    facets,
    receipt_rows: rows, // "facet / government ID → sealed entry / opaque", "facet / full birth date → sealed entry / opaque"
    sealed_entry_outcome: "accepted-partial",
    holder_round_trip_ok: roundTrip,
    isolation: { grade: "structural-shape-only", note: isolationNote },
    um_conformance_claimed: false,
    note:
      "runtime sealed-facet surface: REAL JWE crypto (emit + holder decrypt), sealed-entry evaluation " +
      "(opaque, accepted-partial). Q1 isolation is Grade-1 structural. NOT full evaluator conformance.",
  };
}

// ===========================================================================
// 5) CONFORMANCE-RUNNER REGISTRATION HOOK (the shared v0.4 runner wires this
//    with the documented block — applied by the integration step, not by this module).
// ===========================================================================

/** The 4 fixture files owns (coverage-matrix §1 rows 16/17/18/69). */
export const feature_FIXTURE_FILENAMES = Object.freeze([
  "valid/manifest-with-encrypted-facet.jsonld",
  "valid/manifest-with-isolated-facets.jsonld",
  "valid/encrypted-facet-sealed-entry.jsonld",
  "invalid/encrypted-facet-malformed-jwe.jsonld",
]);

/**
 * Evaluate ONE fixture against its expected.json entry contract:
 *   entry.validationMode "evaluation" ⇒ evaluateWo132 under entry.evaluationContext
 *   otherwise                         ⇒ structuralVerdictWo132 (clock-independent)
 * Returns { result: "accept"|"reject", reason, receipt? } — the adapter shape
 * the runner pattern uses, mirroring featureFixtureHandler exactly.
 */
export async function featureFixtureHandler(fixtureJson, expectedEntry = {}) {
  if (expectedEntry.validationMode === "evaluation") {
    const { result, receipt } = await evaluateWo132(fixtureJson, expectedEntry.evaluationContext || {});
    return {
      result,
      reason: receipt.warnings?.[0]?.message || receipt.outcome,
      receipt,
    };
  }
  const verdict = await structuralVerdictWo132(fixtureJson);
  return { result: verdict.result, reason: verdict.reasons.join("; ") || "structural contract satisfied" };
}

/**
 * Registration hook for the shared v0.4 conformance runner. Contract
 * (identical to registerWo134):
 *   registry.register(filename, asyncHandler(fixtureJson, expectedEntry))
 * The integrator wires it with exactly:
 *   import { registerWo132 } from "../manifest/jwe-sealed-facets.mjs";
 *   registerWo132(registry);
 */
export function registerWo132(registry) {
  if (!registry || typeof registry.register !== "function") {
    throw new Error("registerWo132: registry with a register(filename, handler) function required");
  }
  for (const filename of feature_FIXTURE_FILENAMES) {
    registry.register(filename, featureFixtureHandler);
  }
  return feature_FIXTURE_FILENAMES.length;
}
