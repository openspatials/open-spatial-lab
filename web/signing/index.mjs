// public API of the signing crypto library (STANDALONE).
//
// This directory is a self-contained trust-spine keystone: Ed25519 (platform
// WebCrypto) + RFC 8785 JCS canonicalization + DID key binding + UM Signature
// Profile A shape. It imports NOTHING outside web/signing/ and is imported by
// NOTHING yet — integration into the live demo (app.js / live-adapter.js) is
// deliberately a separate change, so this library's correctness is
// proven in isolation first (node web/signing/verify-vectors.mjs).
//
// public API (exact shape the change specifies):
//   sign(obj, privateKey[, opts])            -> Promise<{ signature, protected }>
//   verify(obj, signature, didOrKey[, opts]) -> Promise<boolean>
//   canonicalize(obj)                        -> Uint8Array   (RFC 8785 UTF-8 bytes)
//
// Everything else is exported for the vector runner,, and tooling.

export { sign, verify } from "./um-signature-profile-a.mjs";
export { jcsCanonicalizeToBytes as canonicalize, jcsCanonicalize as canonicalizeToString } from "./jcs-rfc8785.mjs";

// I-JSON input discipline (adversarial-hardening follow-up, HARDENING- B1/B2):
// strict parse for UNTRUSTED manifest text (duplicate keys + >2^53 numbers rejected)
// and the unsafe-number walker the verifier enforces by default.
export { I_JSON_MAX_SAFE_NUMBER, findUnsafeNumber, isUnsafeSigningNumber, parseIJson } from "./ijson.mjs";

// Profile A issuer/consumer one-call forms + metadata.
export {
  PROFILE_A,
  SIGNING_CONFORMANCE,
  attachSignatureProfileA,
  computeSigningInput,
  computeSigningInputString,
  verifyManifestProfileA,
} from "./um-signature-profile-a.mjs";

// Ed25519 primitives and key-format helpers.
export {
  ED25519_PKCS8_PREFIX,
  ED25519_SPKI_PREFIX,
  derivePublicKeyRaw,
  generateKeyPair,
  importPrivateKey,
  importPublicKey,
  pkcs8ToSeed,
  publicKeyInputToRaw,
  rawPublicKeyToSpki,
  seedToPkcs8,
  signBytes,
  spkiToRawPublicKey,
  verifyBytes,
} from "./ed25519.mjs";

// DID binding (see did.mjs header for the first-class / offline / stub tiers).
export {
  KeyNotDerivableError,
  MULTICODEC_ED25519_PUB,
  checkKeyRefConsistency,
  didWebToUrl,
  extractEd25519PublicKey,
  parseDidPkh,
  publicKeyToDidKey,
  publicKeyToDidPkhSolana,
  resolveDidKey,
  resolveDidPkh,
  resolveDidWeb,
  resolveKeyRefOffline,
  splitDidUrl,
} from "./did.mjs";

// Codecs (exported for tests and adjacent tooling).
export {
  base58btcDecode,
  base58btcEncode,
  base64ToBytes,
  base64UrlToBytes,
  bytesEqual,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  hexToBytes,
  utf8Decode,
  utf8Encode,
} from "./codecs.mjs";
