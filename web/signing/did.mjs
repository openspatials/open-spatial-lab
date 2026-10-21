// DID <-> Ed25519 verification-key binding (did:key / did:web / did:pkh).
//
// ---------------------------------------------------------------------------
// SCOPE — set by the UM conformance suite, read before extending this file.
// ---------------------------------------------------------------------------
// The UM v0.4 suite states: "DID key resolution is deliberately out of scope.
// The suite performs no DID-document dereferencing. Every fixture that verifies a
// signature embeds its verifying public key directly (signature.publicKeySpkiB64)
// ... the reference evaluator records keyRefResolution: 'unresolved'"
// (universalmanifest conformance/README.md §"Scope and status of the v0.4 suite").
// Accordingly, the tiers in this module are:
//
//   FIRST-CLASS (offline, byte-provable, used by the Profile A verify ladder):
//     - did:key      — the key IS the identifier (multibase base58btc of
//                      multicodec 0xed01 + 32 raw key bytes). Derivation and
//                      resolution are pure byte math; no network can even exist.
//     - keyRef ↔ embedded-key CONSISTENCY — when a signature carries BOTH a
//                      resolvable keyRef (did:key, did:pkh:solana) and an embedded
//                      publicKeySpkiB64, the two MUST bind to the same key
//                      (key-substitution mitigation, UM spec v0.3+ Section 1.6.4).
//
//   SUPPORTED OFFLINE (kept because the task names it; still no network):
//     - did:pkh      — CAIP-10 account DIDs. ONLY the solana namespace encodes an
//                      Ed25519 public key in the address (address = base58btc of
//                      the 32 raw key bytes), so only solana is key-derivable.
//                      eip155 (Ethereum) etc. addresses are HASHES of secp256k1
//                      keys — no Ed25519 key can be derived; we parse them and
//                      throw a precise KeyNotDerivableError. Chain-registry
//                      semantics (which CAIP-2 reference means which network) are
//                      NOT this library's claim.
//
//   OUT-OF-SCOPE STUB (deliberately minimal; matches the UM suite's stance):
//     - did:web      — live resolution requires fetching did.json over HTTPS. This
//                      module ships ONLY (a) the pure URL-derivation rule
//                      (did:web spec §3.2 — testable offline) and (b) key
//                      EXTRACTION from an already-obtained DID document via an
//                      INJECTED documentLoader. There is NO default fetch; calling
//                      resolveDidWeb without a loader throws. Verifiers without a
//                      loader record did:web keyRefs as keyRefResolution:
//                      "unresolved" and verify with the embedded key — exactly the
//                      UM reference evaluator's behavior.

import {
  base58btcDecode,
  base58btcEncode,
  base64UrlToBytes,
  bytesEqual,
} from "./codecs.mjs";
import { publicKeyInputToRaw, rawPublicKeyToSpki, spkiToRawPublicKey } from "./ed25519.mjs";

// multicodec ed25519-pub (0xed) as unsigned varint -> the two bytes 0xed 0x01.
export const MULTICODEC_ED25519_PUB = Uint8Array.from([0xed, 0x01]);

export class KeyNotDerivableError extends Error {
  constructor(message) {
    super(message);
    this.name = "KeyNotDerivableError";
  }
}

// ---------------------------------------------------------------------------
// did:key (FIRST-CLASS — offline)
// ---------------------------------------------------------------------------

/** 32-byte raw Ed25519 public key -> "did:key:z6Mk..." (multibase base58btc, multicodec 0xed01). */
export function publicKeyToDidKey(publicKeyInput) {
  const raw = publicKeyInputToRaw(publicKeyInput);
  const prefixed = new Uint8Array(2 + raw.length);
  prefixed.set(MULTICODEC_ED25519_PUB, 0);
  prefixed.set(raw, 2);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

/**
 * "did:key:z6Mk..."(#fragment) -> { did, rawPublicKey, publicKeySpki, verificationMethodId }.
 * Pure byte math (multibase 'z' + multicodec 0xed01 + 32 bytes) — offline by construction.
 * Per the did:key method, the verification method id fragment equals the multibase key.
 */
export function resolveDidKey(didUrl) {
  const { did, fragment } = splitDidUrl(didUrl);
  const m = /^did:key:(z[1-9A-HJ-NP-Za-km-z]+)$/.exec(did);
  if (!m) throw new Error(`Not a did:key: ${String(didUrl).slice(0, 64)}`);
  const multibase = m[1];
  const decoded = base58btcDecode(multibase.slice(1)); // strip multibase prefix 'z'
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error("did:key does not encode an Ed25519 public key (expected multicodec 0xed01 + 32 bytes)");
  }
  if (fragment && fragment !== multibase) {
    throw new Error(`did:key fragment ${fragment} does not match key id ${multibase}`);
  }
  const rawPublicKey = decoded.slice(2);
  return {
    did,
    rawPublicKey,
    publicKeySpki: rawPublicKeyToSpki(rawPublicKey),
    verificationMethodId: `${did}#${multibase}`,
  };
}

// ---------------------------------------------------------------------------
// did:pkh (SUPPORTED OFFLINE — solana derivable, others parse-only)
// ---------------------------------------------------------------------------

/** Parse a CAIP-10-based did:pkh into { did, namespace, chainRef, address, fragment }. */
export function parseDidPkh(didUrl) {
  const { did, fragment } = splitDidUrl(didUrl);
  const m = /^did:pkh:([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32}):([.%a-zA-Z0-9]{1,128})$/.exec(did);
  if (!m) throw new Error(`Not a CAIP-10 did:pkh: ${String(didUrl).slice(0, 96)}`);
  return { did, namespace: m[1], chainRef: m[2], address: m[3], fragment };
}

/**
 * did:pkh -> Ed25519 verification key, ONLY where the address encodes one:
 *   solana: address = base58btc(32-byte Ed25519 public key)  -> derivable.
 *   everything else (eip155, bip122, tezos, ...)             -> KeyNotDerivableError.
 * The error is the honest answer: an eip155 address is keccak256(secp256k1-pub)[12..],
 * so no Ed25519 key exists to return. Callers needing those chains must obtain key
 * material out-of-band (that resolution is outside this library's proven scope).
 */
export function resolveDidPkh(didUrl) {
  const parsed = parseDidPkh(didUrl);
  if (parsed.namespace !== "solana") {
    throw new KeyNotDerivableError(
      `did:pkh namespace "${parsed.namespace}" does not encode an Ed25519 public key in the address; ` +
        "only did:pkh:solana addresses are key-derivable offline"
    );
  }
  const rawPublicKey = base58btcDecode(parsed.address);
  if (rawPublicKey.length !== 32) {
    throw new Error(`did:pkh:solana address must decode to 32 bytes (got ${rawPublicKey.length})`);
  }
  return {
    did: parsed.did,
    rawPublicKey,
    publicKeySpki: rawPublicKeyToSpki(rawPublicKey),
    verificationMethodId: `${parsed.did}#blockchainAccountId`,
  };
}

/** 32-byte Ed25519 public key + CAIP-2 chainRef -> did:pkh:solana DID (address = base58 of key). */
export function publicKeyToDidPkhSolana(publicKeyInput, chainRef) {
  if (typeof chainRef !== "string" || chainRef.length === 0) {
    throw new Error("publicKeyToDidPkhSolana requires an explicit CAIP-2 chain reference (e.g. the base58 genesis-hash prefix)");
  }
  const raw = publicKeyInputToRaw(publicKeyInput);
  return `did:pkh:solana:${chainRef}:${base58btcEncode(raw)}`;
}

// ---------------------------------------------------------------------------
// did:web (OUT-OF-SCOPE STUB — pure URL rule + injected-loader extraction only)
// ---------------------------------------------------------------------------

/**
 * did:web -> DID-document URL (did:web method spec §3.2 "Read"):
 *   did:web:example.com               -> https://example.com/.well-known/did.json
 *   did:web:example.com:user:alice    -> https://example.com/user/alice/did.json
 *   did:web:example.com%3A3000        -> https://example.com:3000/.well-known/did.json
 * Pure string transform; performs NO network access.
 */
export function didWebToUrl(didUrl) {
  const { did } = splitDidUrl(didUrl);
  if (!did.startsWith("did:web:")) throw new Error(`Not a did:web: ${String(didUrl).slice(0, 96)}`);
  const parts = did.slice("did:web:".length).split(":").map((p) => decodeURIComponent(p));
  const host = parts.shift();
  if (!host) throw new Error("did:web missing host");
  if (parts.length === 0) return `https://${host}/.well-known/did.json`;
  if (parts.some((p) => p.length === 0)) throw new Error("did:web has an empty path segment");
  return `https://${host}/${parts.join("/")}/did.json`;
}

/**
 * Resolve a did:web via an INJECTED documentLoader(url) -> DID document object.
 * No loader => throws (this library never fetches on its own; the UM conformance
 * suite treats live DID resolution as out of scope, and so do we).
 */
export async function resolveDidWeb(didUrl, { documentLoader } = {}) {
  if (typeof documentLoader !== "function") {
    throw new Error(
      "did:web resolution requires an injected documentLoader (live DID dereferencing is out of scope; " +
        "verify against the embedded publicKeySpkiB64 instead, recording keyRefResolution:'unresolved')"
    );
  }
  const { did, fragment } = splitDidUrl(didUrl);
  const url = didWebToUrl(did);
  const doc = await documentLoader(url);
  if (!doc || typeof doc !== "object") throw new Error(`documentLoader returned no DID document for ${url}`);
  if (typeof doc.id === "string" && doc.id !== did) {
    throw new Error(`DID document id ${doc.id} does not match requested ${did}`);
  }
  const vm = pickVerificationMethod(doc, did, fragment);
  const rawPublicKey = extractEd25519PublicKey(vm);
  return {
    did,
    rawPublicKey,
    publicKeySpki: rawPublicKeyToSpki(rawPublicKey),
    verificationMethodId: typeof vm.id === "string" ? vm.id : `${did}#unnamed`,
    document: doc,
  };
}

function pickVerificationMethod(doc, did, fragment) {
  const methods = Array.isArray(doc.verificationMethod) ? doc.verificationMethod : [];
  if (methods.length === 0) throw new Error("DID document has no verificationMethod entries");
  if (fragment) {
    const wanted = `${did}#${fragment}`;
    const hit = methods.find((m) => m && (m.id === wanted || m.id === `#${fragment}`));
    if (!hit) throw new Error(`DID document has no verification method ${wanted}`);
    return hit;
  }
  const ed = methods.find((m) => canExtractEd25519(m));
  if (!ed) throw new Error("DID document has no Ed25519-capable verification method");
  return ed;
}

function canExtractEd25519(vm) {
  try {
    extractEd25519PublicKey(vm);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract a 32-byte Ed25519 key from a verification method carrying
 * publicKeyMultibase (Multikey / Ed25519VerificationKey2020), publicKeyJwk
 * (OKP/Ed25519), or legacy publicKeyBase58 (Ed25519VerificationKey2018).
 */
export function extractEd25519PublicKey(vm) {
  if (!vm || typeof vm !== "object") throw new Error("No verification method");
  if (typeof vm.publicKeyMultibase === "string") {
    if (!vm.publicKeyMultibase.startsWith("z")) {
      throw new Error("publicKeyMultibase must be base58btc ('z' multibase prefix)");
    }
    const decoded = base58btcDecode(vm.publicKeyMultibase.slice(1));
    if (decoded.length === 34 && decoded[0] === 0xed && decoded[1] === 0x01) return decoded.slice(2);
    if (decoded.length === 32) return decoded; // some legacy docs omit the multicodec header
    throw new Error("publicKeyMultibase does not encode an Ed25519 public key");
  }
  if (vm.publicKeyJwk && typeof vm.publicKeyJwk === "object") {
    const jwk = vm.publicKeyJwk;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
      throw new Error("publicKeyJwk is not an OKP/Ed25519 key");
    }
    const raw = base64UrlToBytes(jwk.x);
    if (raw.length !== 32) throw new Error("publicKeyJwk.x must decode to 32 bytes");
    return raw;
  }
  if (typeof vm.publicKeyBase58 === "string") {
    const raw = base58btcDecode(vm.publicKeyBase58);
    if (raw.length !== 32) throw new Error("publicKeyBase58 must decode to 32 bytes");
    return raw;
  }
  throw new Error("Verification method carries no supported Ed25519 key encoding");
}

// ---------------------------------------------------------------------------
// keyRef resolution ladder (what the Profile A verifier uses)
// ---------------------------------------------------------------------------

/**
 * Offline keyRef resolution ladder. Returns
 *   { resolution: "resolved",   rawPublicKey, publicKeySpki, method }  for did:key / did:pkh:solana
 *   { resolution: "unresolved", method }                               for did:web (no loader),
 *     did:example, HTTPS URLs, and any other identifier — mirroring the UM
 *     reference evaluator's keyRefResolution:"unresolved" for non-derivable refs.
 * Throws only on refs that CLAIM to be derivable but are malformed (bad did:key
 * bytes), because that is evidence of tampering rather than mere unresolvability.
 */
export async function resolveKeyRefOffline(keyRef, { documentLoader } = {}) {
  if (typeof keyRef !== "string" || keyRef.length === 0) {
    return { resolution: "unresolved", method: "none" };
  }
  if (keyRef.startsWith("did:key:")) {
    const r = resolveDidKey(keyRef);
    return { resolution: "resolved", method: "did:key", rawPublicKey: r.rawPublicKey, publicKeySpki: r.publicKeySpki };
  }
  if (keyRef.startsWith("did:pkh:")) {
    try {
      const r = resolveDidPkh(keyRef);
      return { resolution: "resolved", method: "did:pkh:solana", rawPublicKey: r.rawPublicKey, publicKeySpki: r.publicKeySpki };
    } catch (e) {
      if (e instanceof KeyNotDerivableError) return { resolution: "unresolved", method: "did:pkh" };
      throw e; // malformed solana address etc. — tamper-evidence, not unresolvability
    }
  }
  if (keyRef.startsWith("did:web:") && typeof documentLoader === "function") {
    const r = await resolveDidWeb(keyRef, { documentLoader });
    return { resolution: "resolved", method: "did:web", rawPublicKey: r.rawPublicKey, publicKeySpki: r.publicKeySpki };
  }
  return { resolution: "unresolved", method: keyRef.startsWith("did:") ? keyRef.slice(0, keyRef.indexOf(":", 4) === -1 ? undefined : keyRef.indexOf(":", 4)) : "uri" };
}

/**
 * keyRef ↔ embedded-key consistency check (UM spec v0.3+ Section 1.6.4,
 * key-substitution mitigation). Returns
 *   { consistent: true,  keyRefResolution: "resolved" }    keys match
 *   { consistent: false, keyRefResolution: "resolved" }    keys DIFFER — reject!
 *   { consistent: true,  keyRefResolution: "unresolved" }  ref not offline-derivable;
 *     the embedded key stands alone (the UM suite's own posture for did:example/did:web).
 */
export async function checkKeyRefConsistency(keyRef, embeddedSpkiOrRaw, opts = {}) {
  const resolved = await resolveKeyRefOffline(keyRef, opts);
  if (resolved.resolution !== "resolved") {
    return { consistent: true, keyRefResolution: "unresolved", method: resolved.method };
  }
  const embeddedRaw =
    embeddedSpkiOrRaw instanceof Uint8Array && embeddedSpkiOrRaw.length === 44
      ? spkiToRawPublicKey(embeddedSpkiOrRaw)
      : publicKeyInputToRaw(embeddedSpkiOrRaw);
  return {
    consistent: bytesEqual(resolved.rawPublicKey, embeddedRaw),
    keyRefResolution: "resolved",
    method: resolved.method,
  };
}

/** Split "did:...#frag" -> { did, fragment } (fragment undefined when absent). */
export function splitDidUrl(didUrl) {
  const s = String(didUrl);
  const hash = s.indexOf("#");
  if (hash === -1) return { did: s, fragment: undefined };
  return { did: s.slice(0, hash), fragment: s.slice(hash + 1) };
}
