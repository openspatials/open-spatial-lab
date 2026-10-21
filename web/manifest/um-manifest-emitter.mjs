// Universal Manifest v0.4 JSON-LD emitter (from live crossing state).
//
// This is the foundation of the demo's trust spine: it emits a REAL Universal Manifest
// that is STRUCTURALLY VALID against Universal Manifest v0.4
// (), built from the demo's
// live crossing state, and SIGNED under UM Signature Profile A (Ed25519 + JCS-RFC8785)
// using the signing library in web/signing/.
//
// It has ZERO third-party dependencies. In Node it runs from a `.mjs` file regardless of
// the prototype's package.json `type:commonjs`; in a browser it loads as an ES module.
// The only imports are the sibling interface contracts (interfaces.mjs) and the
// signing primitives (../signing/*.mjs) — both plain ESM with no bundler needed.
//
// ---------------------------------------------------------------------------
// WHAT IS PROVEN vs NOT (read before touching the labels)
// ---------------------------------------------------------------------------
// PROVEN by this module + self-verify.mjs:
//   - Schema-valid v0.4 EMISSION: the emitted manifest validates against
//     spec/v0.4/schema.json under ajv Draft 2020-12 (see web/manifest/self-verify.mjs).
//   - A correctly-shaped, REAL signature: Signature Profile A — Ed25519 over the
//     RFC 8785 (JCS) canonical bytes of the manifest with `signature` removed, with the
//     verifying key embedded as `publicKeySpkiB64`. Round-trips through verify.
// NOT proven / NOT claimed here (intentionally — this change flips NO `um_conformance` flag):
//   - Evaluator conformance: the six-stage evaluation sequence + structured `um:Receipt`
//     (Arrive/Verify/Project/Consent/Compose/Receipt). That is job. Schema-valid
//     is NOT evaluator-conformant.
//   - Context hash-pinning, consent semantics, tier logic, revocation. Those are evaluator
//     behaviors, not emission.
//   - Production key management / DID resolution. The demo embeds `publicKeySpkiB64` (the
//     spec's offline/fixture escape hatch) and uses an ephemeral demo key.
//
// ---------------------------------------------------------------------------
// SIGNATURE PROFILE A (universalmanifest spec/v0.2/SIGNATURE-PROFILE.md §4, unchanged in v0.4)
// ---------------------------------------------------------------------------
//   signing input = JCS-RFC8785( manifest with `signature` (and presentationProof,
//                   postQuantumSignature) removed ) as UTF-8 bytes → Ed25519-sign.
//   signature.algorithm       = "Ed25519"          (const in v0.4 schema $defs/signatureV04)
//   signature.canonicalization= "JCS-RFC8785"       (const)
//   signature.keyRef          = a URI (DID URL or HTTPS) naming the key
//   signature.value           = base64url(64-byte Ed25519 signature), no padding
//   signature.publicKeySpkiB64= standard-base64(SPKI DER of the verifying key)  [offline path]
//
// SIGN SEAM (below, in buildAndSignManifest): NOW LIVE-WIRED. web/signing/
// has landed AND the live crossing calls buildAndSignManifest at crossing time (see
// live-adapter.js `//` — sign on exit, verify on arrival). This module signs for
// real by default. If a caller passes no signing key, we emit an UNSIGNED-SHAPED draft
// (a placeholder signature slot) purely for the emitter's own shape tests — a real "valid
// v0.4" emit requires a key (v0.4 makes `signature` REQUIRED for validity).
//
// DID SUBJECT BINDING (Signature Profile A option `bindDidSubject`): when set, the
// keyRef (and, absent an explicit subject, the manifest subject) is bound to the did:key
// derived from the ACTUAL signing key. That makes the keyRef OFFLINE-RESOLVABLE, so the
// verifier runs the UM v0.3+ §1.6.4 keyRef<->embedded-key CONSISTENCY check (key-substitution
// mitigation) as a first-class check rather than standing on the embedded key alone.

import {
  UM_V04_CONTEXT,
  UM_V04_MANIFEST_VERSION,
  UM_FACET_TYPE,
  UM_ENTITY_TYPE,
  makeAvatarDefinition,
  validateAvatarDefinition,
  makeLoadingPointer,
  validateLoadingPointer,
} from "./interfaces.mjs";

// BEGIN — RP1 / Spatial-Fabric pointer+facet model (new web/manifest/rp1-model.mjs).
// The RP1 crossing model (parent/child scope + attachment) is built in that module; this
// emitter only INTEGRATES its output into the manifest's facets/pointers/consents when the
// caller supplies live navigator state (state.rp1). See the section in buildManifest.
import { buildRp1Section } from "./rp1-model.mjs";
// END

// signing library (web/signing). Present in this prototype; imported statically.
import { jcsCanonicalizeToBytes } from "../signing/jcs-rfc8785.mjs";
// Hardening B1 (HARDENING-signing.md): I-JSON number discipline on the emitter's
// SIGN path — refuse to sign a manifest carrying a number outside ±(2^53-1), because
// such a double aliases distinct JSON texts under one signature.
import { findUnsafeNumber } from "../signing/ijson.mjs";
import {
  generateKeyPair,
  signBytes,
  verifyBytes,
  derivePublicKeyRaw,
  rawPublicKeyToSpki,
  bytesToBase64,
  bytesToBase64Url,
} from "../signing/ed25519.mjs";
// did:key derivation for the DID subject binding, and the detailed
// verifier ladder (used on the arrival side so a verify FAILURE reports WHY, honestly).
import { publicKeyToDidKey } from "../signing/did.mjs";
import { verifyManifestProfileA } from "../signing/um-signature-profile-a.mjs";

// ===========================================================================
// v0.4 constants / defaults
// ===========================================================================
export const UM_MANIFEST_EMITTER_VERSION = "runtime-v1";

// The keys the v0.4 signing input MUST NOT include (Signature Profile A §4 + the
// presentationProof/postQuantumSignature exclusions noted in v0.4 CONFORMANCE §Base 1.6.3).
// Hardening B3 alignment (HARDENING-signing.md): `signature` is excluded ALWAYS;
// presentationProof/postQuantumSignature are excluded off the VALIDATED version gate
// (manifestVersion === the string "0.4") — exactly the library's rule
// (um-signature-profile-a.mjs signingExclusions), so the emitter and the library can
// never compute divergent signed byte sets. For every manifest this emitter builds
// (manifestVersion is always the string UM_V04_MANIFEST_VERSION) the gate is
// equivalent to the previous unconditional strip — byte-identical output.
const SIGNING_INPUT_ALWAYS_EXCLUDED = ["signature"];
const SIGNING_INPUT_V04_EXCLUDED = ["presentationProof", "postQuantumSignature"];

// Machine-readable descriptor of what this emitter proves. Mirrors the scoped-descriptor
// pattern of GEOPOSE_CONFORMANCE / IWPS_CONFORMANCE — a scoped truth, NOT a bare boolean.
// IMPORTANT: this does NOT set `um_conformance` true anywhere; schema-valid ≠ conformant.
export const UM_MANIFEST_EMISSION = Object.freeze({
  standard: "Universal Manifest v0.4 (Base / Tier-0)",
  context: UM_V04_CONTEXT,
  manifestVersion: UM_V04_MANIFEST_VERSION,
  // The emitted manifest validates against spec/v0.4/schema.json (ajv Draft 2020-12).
  // Proven by web/manifest/self-verify.mjs (re-runnable, network-free).
  schema_valid_v04: true,
  // Signed with a real Ed25519 signature under Signature Profile A.
  signature_profile: "A (Ed25519 + JCS-RFC8785)",
  signed: true,
  // NOT the v0.4 Evaluator conformance program (no six-stage receipt evaluation here).
  evaluator_conformance: false,
  // the live crossing now SIGNS on exit and VERIFIES on arrival (live-adapter.js
  // `//`). This is signing WIRING only — it flips NO um_conformance flag.
  live_signing_wired: true,
  full_conformance: false,
  scope_boundary:
    "Universal Manifest v0.4 manifest — SCHEMA-VALID emission (structural, ajv Draft 2020-12) " +
    "signed under Signature Profile A (Ed25519 + JCS-RFC8785, runtime crypto), live-wired into " +
    "the crossing (runtime: sign on exit, verify on arrival, did:key subject binding); NOT " +
    "evaluator conformance (six-stage receipt = runtime). um_conformance stays false " +
    "(signing != conformance).",
});

// ===========================================================================
// The emitter.
// ===========================================================================

/**
 * Build a v0.4 manifest OBJECT (UNSIGNED — carries a placeholder signature slot) from
 * the demo's live crossing state. This is the pure shape builder; buildAndSignManifest()
 * wraps it with a real Signature Profile A signature.
 *
 * @param {object} state  Live crossing state. Recognized fields (all optional; the
 *   emitter is defensive so it never throws on partial state):
 *     subject         string   Subject identifier URI (a DID). Falls back to a
 *                              deterministic did:web-ish demo id from continuity_id.
 *     continuityId    string   The demo's cross-world continuity id (used for @id + subject fallback).
 *     handoffId       string   The crossing correlation id (recorded in a continuity facet).
 *     sourceLocationId string  Source world location id (continuity facet).
 *     targetLocationId string  Target world location id (continuity facet).
 *     avatar          object   An AvatarDefinition (interfaces.mjs) OR raw fields it accepts.
 *     loading         object   A LoadingPointer (interfaces.mjs) OR raw fields it accepts.
 *     rp1 object [] Live World Navigator debug (navigator scope/attachment
 *                              state). When present, the emitter adds the RP1 spatial-fabric
 *                              facets/pointers/consents (parent/child scope + attachment).
 *     rp1Options object [] Optional freshness/consent overrides for the RP1 model.
 *     issuedAt        string   ISO 8601. Defaults to now.
 *     ttlSeconds      number   Lifetime; expiresAt = issuedAt + ttlSeconds. Default 3600.
 *     keyRef          string   signature.keyRef URI. Defaults to `${subject}#keys-1`.
 *     id              string   Manifest @id. Defaults to a urn:uuid derived from continuity/handoff.
 * @returns {object} an UNSIGNED v0.4-shaped manifest (signature slot present but placeholder).
 */
export function buildManifest(state) {
  const s = state && typeof state === "object" ? state : {};

  const issuedAt = isoOrNow(s.issuedAt);
  const ttl = Number.isFinite(Number(s.ttlSeconds)) ? Number(s.ttlSeconds) : 3600;
  const expiresAt = new Date(Date.parse(issuedAt) + ttl * 1000).toISOString();

  const continuityId = s.continuityId != null ? String(s.continuityId) : null;
  const subject = deriveSubject(s.subject, continuityId);
  const manifestId = s.id != null ? String(s.id) : deriveManifestId(continuityId, s.handoffId);
  const keyRef = s.keyRef != null ? String(s.keyRef) : `${subject}#keys-1`;

  const manifest = {
    "@context": UM_V04_CONTEXT,
    "@id": manifestId,
    "@type": "um:Manifest",
    manifestVersion: UM_V04_MANIFEST_VERSION,
    subject,
    issuedAt,
    expiresAt,
  };

  // ---- Facets (each REQUIRES @id + @type in v0.4) ----------------------------------
  const facets = [];

  // 1) Avatar facet — from the AvatarDefinition interface.
  if (s.avatar) {
    const def = looksLikeAvatarDefinition(s.avatar) ? s.avatar : makeAvatarDefinition(s.avatar);
    const check = validateAvatarDefinition(def);
    if (check.valid) {
      facets.push(avatarFacetFromDefinition(def));
    }
    // If invalid we simply omit it — the emitter must never produce a malformed facet.
  }

  // 2) Continuity facet — the cross-world continuity the demo has always carried, now as
  //    a v0.4 facet (@id + @type + a body). Non-PII: ids + location ids only.
  const continuityFacet = continuityFacetFrom(s, continuityId);
  if (continuityFacet) facets.push(continuityFacet);

  if (facets.length > 0) manifest.facets = facets;

  // ---- Pointers (each REQUIRES @type in v0.4) --------------------------------------
  const pointers = [];
  if (s.loading) {
    const ptr = looksLikeLoadingPointer(s.loading) ? s.loading : makeLoadingPointer(s.loading);
    const check = validateLoadingPointer(ptr);
    if (check.valid) {
      pointers.push(loadingPointerFromInterface(ptr, expiresAt));
    }
  }
  // BEGIN — OPTIONAL additional loading-content pointers.
  //   loadingPointers  array  Each item a LoadingPointer (interfaces.mjs) OR raw fields
  //                           makeLoadingPointer accepts. Used to carry the
  //                           destination's metaverse.portal.* loading-content pointers
  //                           (loadingScreen/loadingBranding/loadingInstructions/
  //                           estimatedLoadTime) in the SIGNED manifest, through the same
  // LoadingPointer seam as `loading` above. Additive and
  //                           optional: absent => byte-identical output to pre-127.
  //                           Demonstration-only content; no conformance flag is flipped.
  if (Array.isArray(s.loadingPointers)) {
    for (const raw of s.loadingPointers) {
      if (!raw) continue;
      const ptr = looksLikeLoadingPointer(raw) ? raw : makeLoadingPointer(raw);
      const check = validateLoadingPointer(ptr);
      if (check.valid) {
        pointers.push(loadingPointerFromInterface(ptr, expiresAt));
      }
    }
  }
  // END
  if (pointers.length > 0) manifest.pointers = pointers;

  // BEGIN — RP1 / Spatial-Fabric section.
  // When the caller supplies live World Navigator crossing state (state.rp1 — the
  // navigator debug object, optionally with a {rp1Options} sibling), express the crossing
  // in RP1's portable data model: parent-scope -> child-scope attachment resolved in one
  // context. This MERGES the RP1 facets/pointers/consents into the manifest so they are
  // part of the SIGNED document (added here, before the signature slot). The heavy lifting
  // lives in rp1-model.mjs; this is a thin, additive integration.
  //
  // state.rp1        object  The live navigator debug (adapter.debugState().navigator).
  // state.rp1Options object  OPTIONAL freshness/consent overrides forwarded to the model
  //                          (issuedAt + ttlSeconds are supplied from this manifest).
  //
  // Honesty: this adds the RP1 MODEL only. RP1 FAIL-CLOSED conformance + journey-07/J22
  // acceptance is; no `um_conformance` flag is flipped here.
  if (s.rp1 && typeof s.rp1 === "object") {
    const rp1Opts = {
      issuedAt,
      ttlSeconds: ttl,
      ...(s.rp1Options && typeof s.rp1Options === "object" ? s.rp1Options : {}),
    };
    const rp1 = buildRp1Section(s.rp1, rp1Opts);
    if (rp1) {
      if (Array.isArray(rp1.facets) && rp1.facets.length > 0) {
        manifest.facets = [...(manifest.facets || []), ...rp1.facets];
      }
      if (Array.isArray(rp1.pointers) && rp1.pointers.length > 0) {
        manifest.pointers = [...(manifest.pointers || []), ...rp1.pointers];
      }
      if (Array.isArray(rp1.consents) && rp1.consents.length > 0) {
        manifest.consents = [...(manifest.consents || []), ...rp1.consents];
      }
    }
  }
  // END

  // ---- Signature SLOT (placeholder; buildAndSignManifest fills it for real) ---------
  // v0.4 requires `signature`; this placeholder is present ONLY so the object shape is
  // complete for the emitter's own tests. It is NOT schema-valid (value/keyRef missing)
  // until signed — that honest distinction is the whole point of v0.4 (unsigned ≠ valid).
  manifest.signature = {
    algorithm: "Ed25519",
    canonicalization: "JCS-RFC8785",
    keyRef,
    // value + publicKeySpkiB64 are populated by buildAndSignManifest().
  };

  return manifest;
}

/**
 * Build AND sign a v0.4 manifest from live crossing state. Returns:
 *   { manifest, signed, keyPair, signingInputBytes, didKey }
 *
 * If `options.keyPair` is provided (a generateKeyPair result or any input its
 * importPrivateKey accepts as `.privateKey`/`.seed`), that key signs. Otherwise a fresh
 * ephemeral demo key is generated. If `options.sign === false`, returns the UNSIGNED-shaped
 * draft (placeholder signature) — used only by the emitter's own shape tests.
 *
 * this is the function the app runtime calls to produce a signed
 * manifest at crossing time (live-adapter.js `_commitPortalHandoff`, sign-on-exit). We
 * self-provision an ephemeral demo key so each crossing emits a genuinely-signed, schema-
 * valid v0.4 manifest (v0.4 makes an unsigned manifest structurally invalid).
 *
 * DID SUBJECT BINDING — `options.bindDidSubject === true`:
 *   - keyRef is set to the did:key DID URL derived from the SIGNING key
 *     (`did:key:z…#z…`), which is OFFLINE-resolvable, so the verifier runs the §1.6.4
 *     keyRef<->embedded-key consistency check as a first-class check.
 *   - the manifest subject is bound to that did:key too, UNLESS the caller passed an
 *     explicit `state.subject` (an explicit subject is never overridden).
 * The embedded `publicKeySpkiB64` is still written (the offline/fixture escape hatch), so
 * the manifest self-verifies with OR without DID resolution.
 */
export async function buildAndSignManifest(state, options = {}) {
  if (options.sign === false) {
    return { manifest: buildManifest(state), signed: false, keyPair: null, signingInputBytes: null, didKey: null };
  }

  // Resolve a signing key: caller-provided, or a fresh ephemeral demo key.
  const keyPair = options.keyPair || (await generateKeyPair());
  const privateKeyInput = pickPrivateKeyInput(keyPair);

  // DID subject binding: derive the did:key from the actual signing key BEFORE
  // building, so the manifest subject/keyRef bind to the key that signs it (offline-
  // resolvable ⇒ the verifier's keyRef<->embedded-key consistency check is first-class).
  let didKey = null;
  const buildState = state && typeof state === "object" ? { ...state } : {};
  if (options.bindDidSubject === true) {
    const rawPublicKey = await derivePublicKeyRaw(privateKeyInput);
    didKey = publicKeyToDidKey(rawPublicKey); // did:key:z6Mk…
    // keyRef = the did:key verification-method URL (fragment == the multibase key id).
    buildState.keyRef = `${didKey}#${didKey.slice("did:key:".length)}`;
    // Bind subject to the did:key unless the caller supplied an explicit subject.
    if (buildState.subject == null || String(buildState.subject).length === 0) {
      buildState.subject = didKey;
    }
  }

  const manifest = buildManifest(buildState);

  // Input discipline on the SIGN path (hardening B1/B3 — the emitter is the demo's
  // production issuer, so it enforces what the library's default sign() keeps opt-in):
  //   - manifestVersion MUST be a string (buildManifest always emits the string "0.4";
  //     this guard pins the exclusion gate to a validated version, per B3);
  //   - the signing input MUST NOT carry a number outside ±(2^53-1) (per B1: such a
  //     double aliases distinct JSON texts, so one signature would cover documents
  //     the issuer never saw). Represent big values as strings instead.
  if (typeof manifest.manifestVersion !== "string") {
    throw new Error("refusing to sign: manifestVersion must be a string (signing-input exclusion gate)");
  }

  // Signature Profile A: canonicalize the manifest WITHOUT the excluded keys.
  const signingInput = stripForSigning(manifest);
  const unsafeNumber = findUnsafeNumber(signingInput);
  if (unsafeNumber) {
    throw new Error(
      `refusing to sign: number ${unsafeNumber.value} at ${unsafeNumber.path} is outside the ` +
        "I-JSON safe range ±(2^53-1); represent big numbers as strings (RFC 8785 Appendix D)"
    );
  }
  const signingInputBytes = jcsCanonicalizeToBytes(signingInput);

  // Sign with the private key.
  const sigBytes = await signBytes(signingInputBytes, privateKeyInput);

  // Embed the verifying key as publicKeySpkiB64 (standard base64 of SPKI DER — the
  // spec's offline/fixture escape hatch, so the manifest self-verifies without DID resolution).
  const publicKeySpki = await resolvePublicKeySpki(keyPair);

  manifest.signature = {
    algorithm: "Ed25519",
    canonicalization: "JCS-RFC8785",
    keyRef: manifest.signature.keyRef,
    created: manifest.issuedAt,
    publicKeySpkiB64: bytesToBase64(publicKeySpki),
    value: bytesToBase64Url(sigBytes),
  };

  return { manifest, signed: true, keyPair, signingInputBytes, didKey };
}

/**
 * Verify a signed v0.4 manifest's signature under Signature Profile A (re-derives the
 * JCS signing input, checks the embedded publicKeySpkiB64 against the 64-byte value).
 * Returns a boolean. This is the emitter's SELF-CHECK that its own output round-trips;
 * it is NOT the v0.4 evaluator (no six-stage receipt) — that is.
 */
export async function verifyManifestSignature(manifest) {
  if (!manifest || typeof manifest !== "object" || !manifest.signature) return false;
  const sig = manifest.signature;
  if (sig.algorithm !== "Ed25519" || sig.canonicalization !== "JCS-RFC8785") return false;
  if (typeof sig.value !== "string" || typeof sig.publicKeySpkiB64 !== "string") return false;
  // Hardening B3 (same rule as the library verifier): a PRESENT but
  // non-string manifestVersion would silently select a different signing-input
  // exclusion set than a spec verifier — fail CLOSED instead of diverging.
  if (
    Object.prototype.hasOwnProperty.call(manifest, "manifestVersion") &&
    typeof manifest.manifestVersion !== "string"
  ) {
    return false;
  }
  // Hardening B1 (same rule as the library verifier): never accept a
  // signature over a document whose numbers alias other JSON texts (>2^53).
  if (findUnsafeNumber(stripForSigning(manifest))) return false;

  const signingInput = stripForSigning(manifest);
  const signingInputBytes = jcsCanonicalizeToBytes(signingInput);
  try {
    return await verifyBytes(signingInputBytes, sig.value, sig.publicKeySpkiB64);
  } catch {
    return false;
  }
}

/**
 * DETAILED verify of a signed v0.4 manifest, for the RECEIVING side of the
 * crossing. Delegates to Profile A verifier ladder (verifyManifestProfileA), which
 * enforces the profile pair (§5.1), recomputes the v0.4 §1.6.3 signing input, obtains the
 * key (embedded publicKeySpkiB64 is first-class), runs the §1.6.4 keyRef<->embedded-key
 * consistency check when the keyRef is offline-derivable (did:key), and verifies Ed25519
 * over the canonical bytes. Returns the report `{ ok, reason, checks:{…} }` — so a
 * verify FAILURE carries WHY (the reason + which checks ran), surfaced HONESTLY, not a bare
 * false. This is the SIGNATURE check only (not the six-stage v0.4 evaluator =);
 * envelope/@type/TTL are the consumer's job (recorded separately by the adapter).
 */
export async function verifyManifestSignatureDetailed(manifest) {
  if (!manifest || typeof manifest !== "object" || !manifest.signature) {
    return { ok: false, reason: "missing-signature", checks: {} };
  }
  try {
    return await verifyManifestProfileA(manifest);
  } catch (e) {
    return { ok: false, reason: `verify-threw:${(e && e.message) || "error"}`, checks: {} };
  }
}

// ===========================================================================
// Facet / pointer builders (turn the published interfaces into v0.4 schema shapes).
// ===========================================================================

/** AvatarDefinition -> a v0.4 `um:Facet` (@id + @type required). */
function avatarFacetFromDefinition(def) {
  const facet = {
    "@id": urnFacetId("avatar", def.avatarId),
    "@type": UM_FACET_TYPE,
    name: "avatar",
  };
  // A non-PII entity body echoing the avatar description. Entity itself needs @id + @type
  // when present as a typed entity; we give it both so it satisfies $defs/entity too.
  const entity = {
    "@id": urnEntityId("avatar", def.avatarId),
    "@type": [UM_ENTITY_TYPE, "um:Avatar"],
    avatarId: def.avatarId,
    variant: def.variant,
  };
  if (def.displayName != null) entity.displayName = def.displayName;
  if (def.equipmentProfile != null) entity.equipmentProfile = def.equipmentProfile;
  if (Array.isArray(def.equippedItems) && def.equippedItems.length > 0) {
    entity.equippedItems = def.equippedItems;
  }
  if (def.poseRef != null) entity.poseRef = def.poseRef;
  facet.entity = entity;
  if (isTier(def.requiredTrustTier)) facet.requiredTrustTier = def.requiredTrustTier;
  return facet;
}

/** Live state -> a v0.4 continuity `um:Facet` (@id + @type + non-PII continuity body). */
function continuityFacetFrom(s, continuityId) {
  const hasAny =
    continuityId != null || s.handoffId != null || s.sourceLocationId != null || s.targetLocationId != null;
  if (!hasAny) return null;
  const facet = {
    "@id": urnFacetId("continuity", continuityId || s.handoffId || "crossing"),
    "@type": UM_FACET_TYPE,
    name: "continuity",
    entity: {
      "@id": urnEntityId("continuity", continuityId || s.handoffId || "crossing"),
      "@type": [UM_ENTITY_TYPE, "um:Continuity"],
    },
  };
  const body = facet.entity;
  if (continuityId != null) body.continuityId = String(continuityId);
  if (s.handoffId != null) body.handoffId = String(s.handoffId);
  if (s.sourceLocationId != null) body.sourceLocationId = String(s.sourceLocationId);
  if (s.targetLocationId != null) body.targetLocationId = String(s.targetLocationId);
  return facet;
}

/** LoadingPointer -> a v0.4 `pointer` (@type required; inherits manifest expiry if unset). */
function loadingPointerFromInterface(ptr, manifestExpiresAt) {
  const out = { "@type": ptr.pointerType };
  if (ptr.pointerId != null) out["@id"] = urnPointerId("loading", ptr.pointerId);
  if (ptr.target != null) out.target = ptr.target;
  if (ptr.label != null) out.label = ptr.label;
  out.expiresAt = ptr.expiresAt != null ? ptr.expiresAt : manifestExpiresAt;
  return out;
}

// ===========================================================================
// Signing-input helpers (Signature Profile A canonicalization discipline).
// ===========================================================================

/**
 * Return a shallow copy of the manifest with the signing-excluded keys removed.
 * `signature` always; presentationProof/postQuantumSignature when manifestVersion is
 * the VALIDATED string "0.4" (hardening B3 — same gate as the library, so the
 * two can never diverge on which bytes are signed).
 */
function stripForSigning(manifest) {
  const excluded =
    typeof manifest.manifestVersion === "string" && manifest.manifestVersion === "0.4"
      ? [...SIGNING_INPUT_ALWAYS_EXCLUDED, ...SIGNING_INPUT_V04_EXCLUDED]
      : SIGNING_INPUT_ALWAYS_EXCLUDED;
  const copy = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (excluded.includes(k)) continue;
    copy[k] = v;
  }
  return copy;
}

/** Accept a variety of key shapes and produce a private-key input for signBytes. */
function pickPrivateKeyInput(keyPair) {
  if (!keyPair) throw new Error("no signing key provided");
  // generateKeyPair() returns { privateKey (CryptoKey), seed (Uint8Array), ... }.
  if (keyPair.privateKey) return keyPair.privateKey;
  if (keyPair.seed) return keyPair.seed;
  // Also accept a raw CryptoKey / seed / pkcs8 passed directly.
  return keyPair;
}

/** Resolve the SPKI DER bytes of the verifying key from a key shape. */
async function resolvePublicKeySpki(keyPair) {
  if (keyPair && keyPair.publicKeySpki instanceof Uint8Array) return keyPair.publicKeySpki;
  if (keyPair && keyPair.rawPublicKey instanceof Uint8Array) {
    return rawPublicKeyToSpki(keyPair.rawPublicKey);
  }
  // Derive from the private half.
  const raw = await derivePublicKeyRaw(pickPrivateKeyInput(keyPair));
  return rawPublicKeyToSpki(raw);
}

// ===========================================================================
// Identity / URN helpers.
// ===========================================================================
function deriveSubject(explicit, continuityId) {
  if (explicit != null && String(explicit).length > 0) return String(explicit);
  // Deterministic demo subject DID from the continuity id (non-authoritative — a real
  // deployment binds `subject` to a resolvable DID). did:web-style, safe slug.
  const slug = slugify(continuityId || "anon");
  return `did:web:demo.local:user:${slug}`;
}

function deriveManifestId(continuityId, handoffId) {
  // v0.4 @id MUST be a globally-unique opaque id with NO PII (schema.json line 31). We use
  // a urn:uuid derived deterministically from continuity+handoff so a crossing is stable,
  // but fall back to a random uuid when nothing is available.
  const seed = `${continuityId || ""}:${handoffId || ""}`;
  if (seed === ":") return `urn:uuid:${randomUuidV4()}`;
  return `urn:uuid:${uuidV4FromSeed(seed)}`;
}

function urnFacetId(kind, id) {
  return `urn:um:facet:${kind}:${slugify(id)}`;
}
function urnEntityId(kind, id) {
  return `urn:um:entity:${kind}:${slugify(id)}`;
}
function urnPointerId(kind, id) {
  return `urn:um:pointer:${kind}:${slugify(id)}`;
}

function slugify(v) {
  return String(v == null ? "anon" : v)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "anon";
}

// ===========================================================================
// Small type helpers.
// ===========================================================================
function isoOrNow(v) {
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  return new Date().toISOString();
}
function isTier(v) {
  return Number.isInteger(v) && v >= 0 && v <= 3;
}
function looksLikeAvatarDefinition(v) {
  return v && typeof v === "object" && "avatarId" in v && "variant" in v;
}
function looksLikeLoadingPointer(v) {
  return v && typeof v === "object" && "pointerType" in v;
}

// UUIDv4 — random (crypto.randomUUID when available) and a deterministic seeded variant so
// a given crossing produces a stable @id. Both are RFC-4122 v4-shaped (version 4, variant 10).
function randomUuidV4() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return uuidFromBytes(b);
}
function uuidV4FromSeed(seed) {
  // FNV-1a-seeded 16 bytes → v4-shaped. Deterministic, non-cryptographic (fine for an @id).
  const bytes = new Uint8Array(16);
  let h = 0x811c9dc5;
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < seed.length; j++) {
      h ^= seed.charCodeAt(j);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = Math.imul(h ^ (i + 0x9e3779b9), 0x01000193) >>> 0;
    bytes[i] = h & 0xff;
  }
  return uuidFromBytes(bytes);
}
function uuidFromBytes(b) {
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = [];
  for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
