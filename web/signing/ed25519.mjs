// Ed25519 sign/verify over platform WebCrypto (zero dependencies).
//
// IMPLEMENTATION CHOICE (documented per the task):
//   We use the PLATFORM's Ed25519 — `globalThis.crypto.subtle` (WebCrypto) — not a
//   userland curve implementation. Rationale:
//     1. Vetted: Node's WebCrypto is OpenSSL-backed; browsers ship audited native
//        implementations (Ed25519 in WebCrypto: Chrome/Edge, Firefox, Safari — and
//        Node >= 18.4, stable in the Node 20/22 lines used by this prototype).
//     2. One code path for browser AND Node — no dual-implementation drift, which
//        is exactly the failure mode this keystone task exists to prevent.
//     3. Interop is provable, not assumed: Ed25519 (RFC 8032) is DETERMINISTIC, so
//        verify-vectors.mjs checks our signatures BYTE-FOR-BYTE against RFC 8032
//        §7.1 TEST 1/2/3, and the UM conformance harness's node:crypto verifier
//        accepts our output (crosscheck-um-harness.mjs).
//   The trade-off (WebCrypto is async) is carried through the public API: sign and
//   verify return Promises.
//
// KEY FORMATS (all conversions are fixed-prefix, proven by vectors):
//   raw public key   32 bytes (RFC 8032)
//   SPKI DER public  44 bytes = SPKI_PREFIX(12) + raw          (UM publicKeySpkiB64)
//   PKCS#8 private   48 bytes = PKCS8_PREFIX(16) + seed(32)    (WebCrypto import)
//   JWK              { kty:"OKP", crv:"Ed25519", x[, d] }      (base64url, no pad)

import {
  base64ToBytes,
  base64UrlToBytes,
  bytesEqual,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  hexToBytes,
} from "./codecs.mjs";

// ASN.1 DER prefix for an Ed25519 SubjectPublicKeyInfo (RFC 8410):
// SEQUENCE(42) { SEQUENCE(5) { OID 1.3.101.112 }, BIT STRING(33: 0x00 + key) }
export const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

// ASN.1 DER prefix for an Ed25519 PKCS#8 PrivateKeyInfo (RFC 8410):
// SEQUENCE(46) { INTEGER 0, SEQUENCE(5) { OID 1.3.101.112 },
//                OCTET STRING(34: OCTET STRING(32: seed)) }
export const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error(
      "WebCrypto (crypto.subtle) unavailable — need Node >= 18.4 or a modern browser (secure context)"
    );
  }
  return s;
}

/** Wrap a 32-byte raw Ed25519 public key in SPKI DER (the UM publicKeySpkiB64 payload). */
export function rawPublicKeyToSpki(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) {
    throw new Error("Ed25519 raw public key must be exactly 32 bytes");
  }
  const out = new Uint8Array(44);
  out.set(ED25519_SPKI_PREFIX, 0);
  out.set(raw, 12);
  return out;
}

/** Extract the 32-byte raw public key from Ed25519 SPKI DER (validates the prefix). */
export function spkiToRawPublicKey(spki) {
  if (!(spki instanceof Uint8Array) || spki.length !== 44 || !bytesEqual(spki.subarray(0, 12), ED25519_SPKI_PREFIX)) {
    throw new Error("Not an Ed25519 SPKI DER public key (expected 44 bytes with RFC 8410 prefix)");
  }
  return spki.slice(12);
}

/** Wrap a 32-byte Ed25519 seed in PKCS#8 DER (WebCrypto private-key import format). */
export function seedToPkcs8(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error("Ed25519 seed must be exactly 32 bytes");
  }
  const out = new Uint8Array(48);
  out.set(ED25519_PKCS8_PREFIX, 0);
  out.set(seed, 16);
  return out;
}

/** Extract the 32-byte seed from an Ed25519 PKCS#8 DER private key (validates the prefix). */
export function pkcs8ToSeed(pkcs8) {
  if (!(pkcs8 instanceof Uint8Array) || pkcs8.length !== 48 || !bytesEqual(pkcs8.subarray(0, 16), ED25519_PKCS8_PREFIX)) {
    throw new Error("Not an Ed25519 PKCS#8 DER private key (expected 48 bytes with RFC 8410 prefix)");
  }
  return pkcs8.slice(16);
}

/** Generate a fresh Ed25519 key pair. Returns CryptoKeys plus exportable byte forms. */
export async function generateKeyPair() {
  const pair = await subtle().generateKey("Ed25519", true, ["sign", "verify"]);
  const [rawPublicKey, pkcs8] = await Promise.all([
    subtle().exportKey("raw", pair.publicKey).then((b) => new Uint8Array(b)),
    subtle().exportKey("pkcs8", pair.privateKey).then((b) => new Uint8Array(b)),
  ]);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    rawPublicKey,
    publicKeySpki: rawPublicKeyToSpki(rawPublicKey),
    seed: pkcs8ToSeed(pkcs8),
  };
}

/**
 * Import a private key from flexible input:
 *   CryptoKey | 32-byte seed | 48-byte PKCS#8 | 64-hex seed string |
 *   base64/base64url PKCS#8 string | JWK { kty:"OKP", crv:"Ed25519", d, x }.
 */
export async function importPrivateKey(input) {
  if (isCryptoKey(input)) {
    if (input.type !== "private") throw new Error("Expected a private CryptoKey");
    return input;
  }
  if (input && typeof input === "object" && !(input instanceof Uint8Array)) {
    // JWK
    if (input.kty === "OKP" && input.crv === "Ed25519" && typeof input.d === "string") {
      return importPrivateKey(base64UrlToBytes(input.d));
    }
    throw new Error("Unsupported private key object (expected CryptoKey, Uint8Array, or OKP/Ed25519 JWK with d)");
  }

  let bytes;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (typeof input === "string") {
    bytes = /^[0-9a-fA-F]{64}$/.test(input) ? hexToBytes(input) : base64FlexibleToBytes(input);
  } else {
    throw new Error("Unsupported private key input type");
  }

  const pkcs8 = bytes.length === 32 ? seedToPkcs8(bytes) : bytes.length === 48 ? bytes : null;
  if (!pkcs8) {
    throw new Error(`Unsupported private key byte length ${bytes.length} (expected 32-byte seed or 48-byte PKCS#8)`);
  }
  return subtle().importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
}

/**
 * Import a public key from flexible input:
 *   CryptoKey | 32-byte raw | 44-byte SPKI | 64-hex raw string |
 *   base64/base64url SPKI-or-raw string | JWK { kty:"OKP", crv:"Ed25519", x }.
 */
export async function importPublicKey(input) {
  if (isCryptoKey(input)) {
    if (input.type !== "public") throw new Error("Expected a public CryptoKey");
    return input;
  }
  const raw = publicKeyInputToRaw(input);
  return subtle().importKey("raw", raw, "Ed25519", true, ["verify"]);
}

/** Normalize any accepted public-key input to the 32-byte raw form (no WebCrypto). */
export function publicKeyInputToRaw(input) {
  if (input instanceof Uint8Array) {
    if (input.length === 32) return input;
    if (input.length === 44) return spkiToRawPublicKey(input);
    throw new Error(`Unsupported public key byte length ${input.length} (expected 32 raw or 44 SPKI)`);
  }
  if (typeof input === "string") {
    const bytes = /^[0-9a-fA-F]{64}$/.test(input) ? hexToBytes(input) : base64FlexibleToBytes(input);
    return publicKeyInputToRaw(bytes);
  }
  if (input && typeof input === "object" && input.kty === "OKP" && input.crv === "Ed25519" && typeof input.x === "string") {
    return publicKeyInputToRaw(base64UrlToBytes(input.x));
  }
  throw new Error("Unsupported public key input (expected Uint8Array, hex/base64 string, or OKP/Ed25519 JWK)");
}

/** Derive the raw public key (32 bytes) from any accepted private-key input. */
export async function derivePublicKeyRaw(privateKeyInput) {
  const priv = await importPrivateKey(privateKeyInput);
  // WebCrypto has no direct private->public derivation, but the JWK export of an
  // OKP private key carries the public half in `x` (RFC 8037). Works in Node and
  // browsers alike for extractable keys.
  const jwk = await subtle().exportKey("jwk", priv);
  if (typeof jwk.x !== "string") throw new Error("Private key JWK export missing public component x");
  return base64UrlToBytes(jwk.x);
}

/** Ed25519-sign a byte payload. Returns the 64-byte signature. */
export async function signBytes(payload, privateKeyInput) {
  const priv = await importPrivateKey(privateKeyInput);
  const sig = await subtle().sign("Ed25519", priv, payload);
  return new Uint8Array(sig);
}

/** Verify an Ed25519 signature (64 bytes or base64url string) over a byte payload. */
export async function verifyBytes(payload, signature, publicKeyInput) {
  const pub = await importPublicKey(publicKeyInput);
  const sigBytes = typeof signature === "string" ? base64UrlToBytes(signature) : signature;
  if (!(sigBytes instanceof Uint8Array) || sigBytes.length !== 64) return false;
  return subtle().verify("Ed25519", pub, sigBytes, payload);
}

function isCryptoKey(v) {
  return typeof CryptoKey !== "undefined" && v instanceof CryptoKey;
}

function base64FlexibleToBytes(s) {
  // Accept both standard base64 (with/without padding) and base64url.
  return /[-_]/.test(s) ? base64UrlToBytes(s) : base64ToBytes(s);
}

export { bytesToBase64, bytesToBase64Url, bytesToHex };
