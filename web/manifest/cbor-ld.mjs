// Universal Manifest v0.4 CBOR-LD second encoding (EXT-OPT O1 PREVIEW)
//                     + per-production signing + cross-encoding receipt-equivalence harness.
//
// v0.4's headline is FORMAT INDEPENDENCE: conformance is defined against the abstract
// data model (EXT-OPT O1.1/O1.6), a manifest is written to bytes through a PRODUCTION
// RULE (O1.2), JSON-LD is the reference encoding (O1.3), and CBOR-LD is the second
// encoding defined to demonstrate that independence (O1.4). This module is the demo's
// proof of that thesis: the SAME abstract manifest is produced through BOTH rules,
// consumed back through both, evaluated through the SAME landed evaluation surfaces,
// and the two receipts are BYTE-EQUAL — while each production carries its OWN signature
// over its OWN canonical bytes (O1.5 per-production signing).
//
// ---------------------------------------------------------------------------
// HONESTY CEILING — Tier-2 PREVIEW (read before touching the labels)
// ---------------------------------------------------------------------------
// PROVEN by this module + verify.mjs (re-runnable, network-free):
//   - RFC 8949 §4.2.1 Core Deterministic Encoding CBOR codec (minimal-length arguments,
//     definite lengths, bytewise-lexicographic map-key order, shortest-form floats),
//     vectored against RFC 8949 example encodings; STRICT decoder rejects non-canonical
//     input (non-minimal args, unsorted/duplicate keys, indefinite lengths, tags,
//     non-shortest floats, trailing bytes).
//   - UM-VOCABULARY-SCOPED CBOR-LD production rule (O1.4): term-name -> integer-token
//     compression with the term dictionary DERIVED AT RUNTIME from the PINNED v0.4
//     context (never hardcoded), after verifying the O1.7 context multihash
//     (sha2-256, multibase base58btc) over the exact pinned bytes — FAIL CLOSED on
//     any mismatch. contextReference travels as a context IDENTIFIER, not term strings.
//   - LOSSLESS round-trip: encode -> decode -> deep-equal, for the demo manifest and for
//     the published v0.4 valid fixture corpus re-produced through this rule.
//   - PER-PRODUCTION SIGNING (O1.4 candidate rule / O1.5): Ed25519 over the RFC 8949 CDE
//     bytes of the tokenized form with the Base §1.6.3 exclusions removed; profile pair
//     "Ed25519" + "CBOR-RFC8949-CDE". Verification recomputes the signing input from the
//     bytes CONSUMED — never from another production's bytes (O1.6). A signature that
//     traveled across a re-encoding FAILS verification (negative-tested both directions).
//   - CROSS-ENCODING RECEIPT EQUIVALENCE: same abstract manifest -> both productions ->
//     consume both -> evaluate both -> receipts byte-equal under JCS after the
//     omitProcessedAt discipline (processedAt/receiptId excluded — neither is emitted).
// NOT proven / NOT claimed (PREVIEW boundary — deliberate):
//   - This is NOT a general-purpose CBOR-LD library (no @vocab expansion, no nested
//     inline contexts, no registered global context/token registry). It is the UM
//     vocabulary, scoped and labeled (O1.4 Preview: the registered context-to-token
//     table is itself future WG work — no registered table exists to conform to).
//   - CROSS-ENCODING SIGNATURE PORTABILITY IS NOT CLAIMED. v0.4 signs per production
//     rule; re-encoding REQUIRES re-signing (O1.5). Whether a future profile signs a
//     canonicalization of the abstract model is the recorded OPEN WG QUESTION.
//   - The compact CBOR-LD/COSE handshake profile is FORWARD — not claimed.
//   - The published conformance fixture suite is JSON-LD-only; NO fixture claims are
//     made for CBOR-LD (acceptance here is EQUIVALENCE, not fixtures).
//   - The full six-stage evaluator composition is. Equivalence is proven over
//     the LANDED evaluation surfaces, and the
//     JSON-LD path is ANCHORED byte-exact to the landed engine so the CBOR-LD
//     receipt transitively equals the landed engine's receipt.
//   - No um_conformance flag is flipped anywhere in this change.
//
// Zero third-party dependencies; browser + Node. Imports only sibling manifest modules
// and the signing library (../signing/*.mjs).
//
// Spec inputs (READ-ONLY):
//   spec/v0.4/CONFORMANCE.md §2.2 #2 (evaluator MAY support CBOR-LD)
//   docs/spec-v0.4/ext-opt.html O1.1–O1.7 (abstract model, production rules, CBOR-LD
//   rule + candidate signing, per-production signing, conformance, context integrity)
//   spec/v0.4/schema.jsonld (pinned term vocabulary — vendored byte-exact in
//   ./pinned-context-v04.mjs, multihash-verified before use)

import {
  base64ToBytes,
  base58btcEncode,
  bytesEqual,
  bytesToBase64,
  bytesToBase64Url,
  utf8Decode,
  utf8Encode,
} from "../signing/codecs.mjs";
import {
  derivePublicKeyRaw,
  importPrivateKey,
  rawPublicKeyToSpki,
  signBytes,
  verifyBytes,
} from "../signing/ed25519.mjs";
import { checkKeyRefConsistency, publicKeyToDidKey, resolveKeyRefOffline } from "../signing/did.mjs";
import { jcsCanonicalizeToBytes } from "../signing/jcs-rfc8785.mjs";
import { attachSignatureProfileA, verifyManifestProfileA } from "../signing/um-signature-profile-a.mjs";
import { evaluateConsentStage, validateConsentStructural } from "./consent-gating.mjs";
import { UM_V04_CONTEXT } from "./interfaces.mjs";
import { feature_PINNED_CONTEXT_B64, feature_PINNED_CONTEXT_MULTIHASH } from "./pinned-context-v04.mjs";

// ===========================================================================
// Scoped-truth descriptor (house pattern: UM_MANIFEST_EMISSION / SIGNING_CONFORMANCE).
// Every `true` below is backed by a check in verify.mjs. PREVIEW is the ceiling.
// ===========================================================================
export const feature_CBOR_LD_PREVIEW = Object.freeze({
  standard: "Universal Manifest v0.4 EXT-OPT O1 — CBOR-LD second encoding (PREVIEW)",
  tier: "Tier-2 PREVIEW — EXT-OPT O1 optional feature (CONFORMANCE.md §2.2 #2: evaluator MAY support CBOR-LD)",
  label:
    "CBOR-LD second encoding — EXT-OPT O1 PREVIEW; UM-vocabulary-scoped codec; " +
    "cross-encoding signature portability not claimed (open WG decision); " +
    "compact COSE handshake profile FORWARD, not claimed.",
  media_type: "application/um+cbor-ld", // O1.4
  cbor_rfc8949_cde: true, // §4.2.1 vectors + strict-decoder rejections in verify.mjs §B
  um_vocabulary_scoped_codec: true, // NOT a general-purpose CBOR-LD library (stated in label)
  term_table_derived_from_pinned_context: true, // never hardcoded; regenerate on a context-hash roll
  context_integrity_o17_fail_closed: true, // multihash verified over exact pinned bytes BEFORE table derivation
  lossless_round_trip: true, // demo manifest + full v0.4 valid fixture corpus (§D)
  per_production_signing: true, // Ed25519 + "CBOR-RFC8949-CDE" over tokenized CDE bytes (O1.4/O1.5)
  reencoding_without_resigning_fails: true, // negative-tested BOTH directions (§E)
  cross_encoding_receipt_equivalence: true, // byte-equal receipts under JCS, omitProcessedAt semantics (§F)
  cross_encoding_signature_portability: false, // OPEN WG DECISION (README FORWARD) — NOT claimed
  compact_cose_handshake_profile: false, // FORWARD — NOT claimed
  registered_cborld_token_table: false, // O1.4 Preview: no registered table exists; this is a demo-profile table
  cborld_fixtures_exist: false, // published suite is JSON-LD-only; acceptance = EQUIVALENCE, not fixtures
  full_six_stage_evaluator: false, // composes; equivalence proven over the landed gate (anchored)
  um_conformance_flag_flipped: false,
  scope_boundary:
    "UM v0.4 CBOR-LD PRODUCTION RULE (EXT-OPT O1 PREVIEW), scoped to the UM vocabulary: " +
    "deterministic RFC 8949 CDE encoding of the term-tokenized manifest, token table derived " +
    "from the PINNED v0.4 context after O1.7 multihash verification (fail closed), per-production " +
    "Ed25519 signing over the CDE bytes, and a cross-encoding harness proving JSON-LD and CBOR-LD " +
    "productions of the same abstract manifest evaluate to BYTE-EQUAL receipts. Signatures are " +
    "bound to ONE production each — re-encoding requires re-signing; portability is an open WG " +
    "question and is NOT claimed. No conformance flag is flipped.",
});

// The keys the signing input MUST NOT include (Base §1.6.3, applied per production — O1.4
// "remove the same signing-input exclusions as Base §1.6.3"). Same list use.
const SIGNING_INPUT_EXCLUDED_KEYS = ["signature", "presentationProof", "postQuantumSignature"];

/** The candidate CBOR-LD signing profile identity (O1.4: algorithm + canonicalization
 *  pair IS the profile per Base §1.6.5; "CBOR-RFC8949-CDE" is the candidate value). */
export const PROFILE_CBOR_CDE = Object.freeze({
  algorithm: "Ed25519",
  canonicalization: "CBOR-RFC8949-CDE",
});

// ===========================================================================
// 1) CBOR codec — RFC 8949 §4.2.1 Core Deterministic Encoding, scoped to the
//    JSON-tree data model (+ Uint8Array), which is what a UM manifest is.
//    Supported: null, booleans, numbers (integers + shortest-form floats),
//    strings, arrays, maps (plain objects / Map with integer|string keys),
//    Uint8Array. Rejected (fail closed): NaN/Infinity, undefined, functions,
//    BigInt, unsupported key types.
// ===========================================================================

/** Deterministically encode a value to CBOR bytes per RFC 8949 §4.2.1 CDE. */
export function cborEncodeCde(value) {
  return encodeItem(value);
}

function encodeItem(v) {
  if (v === null) return Uint8Array.of(0xf6);
  if (v === true) return Uint8Array.of(0xf5);
  if (v === false) return Uint8Array.of(0xf4);
  const t = typeof v;
  if (t === "number") return encodeNumber(v);
  if (t === "string") {
    const bytes = utf8Encode(v);
    return concatBytes([encodeHead(3, bytes.length), bytes]);
  }
  if (v instanceof Uint8Array) return concatBytes([encodeHead(2, v.length), v]);
  if (Array.isArray(v)) {
    const parts = [encodeHead(4, v.length)];
    for (const item of v) parts.push(encodeItem(item));
    return concatBytes(parts);
  }
  if (v instanceof Map || (t === "object" && v.constructor === Object) || (t === "object" && Object.getPrototypeOf(v) === null)) {
    return encodeMap(v);
  }
  throw new Error(`cborEncodeCde: unsupported value type ${t === "object" ? Object.prototype.toString.call(v) : t}`);
}

function encodeMap(v) {
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  // Encode each key, then sort entries by BYTEWISE-LEXICOGRAPHIC comparison of the
  // ENCODED key bytes (RFC 8949 §4.2.1 — NOT the RFC 7049 length-first order).
  const encoded = entries.map(([k, val]) => {
    let keyBytes;
    if (typeof k === "number") keyBytes = encodeNumber(k); // tokenized term keys
    else if (typeof k === "string") keyBytes = concatBytes([encodeHead(3, utf8Encode(k).length), utf8Encode(k)]);
    else throw new Error("cborEncodeCde: map keys must be integers or strings");
    return { keyBytes, valBytes: encodeItem(val) };
  });
  encoded.sort((a, b) => compareBytes(a.keyBytes, b.keyBytes));
  for (let i = 1; i < encoded.length; i += 1) {
    if (compareBytes(encoded[i - 1].keyBytes, encoded[i].keyBytes) === 0) {
      throw new Error("cborEncodeCde: duplicate map key");
    }
  }
  const parts = [encodeHead(5, encoded.length)];
  for (const e of encoded) {
    parts.push(e.keyBytes, e.valBytes);
  }
  return concatBytes(parts);
}

function encodeNumber(v) {
  if (!Number.isFinite(v)) throw new Error("cborEncodeCde: non-finite numbers are not JSON-tree values (fail closed)");
  // Integral values encode as CBOR integers (major 0/1); -0 is not an integer.
  if (Number.isSafeInteger(v) && !Object.is(v, -0)) {
    return v >= 0 ? encodeHead(0, v) : encodeHead(1, -1 - v);
  }
  return encodeFloat(v);
}

/** Shortest-form float per §4.2.1 preferred serialization: f16 -> f32 -> f64. */
function encodeFloat(v) {
  const h = tryFloat16Bits(v);
  if (h !== null) return Uint8Array.of(0xf9, (h >>> 8) & 0xff, h & 0xff);
  const dv4 = new DataView(new ArrayBuffer(4));
  dv4.setFloat32(0, v);
  if (dv4.getFloat32(0) === v) {
    return Uint8Array.of(0xfa, dv4.getUint8(0), dv4.getUint8(1), dv4.getUint8(2), dv4.getUint8(3));
  }
  const out = new Uint8Array(9);
  out[0] = 0xfb;
  new DataView(out.buffer).setFloat64(1, v);
  return out;
}

/** IEEE 754 binary16 bit pattern for v when it is EXACTLY representable, else null. */
function tryFloat16Bits(v) {
  if (v === 0) return Object.is(v, -0) ? 0x8000 : 0x0000;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const sign = hi >>> 31;
  const e = (hi >>> 20) & 0x7ff;
  if (e === 0) return null; // double subnormals are far below the f16 range
  const exp = e - 1023;
  let bits = null;
  if (exp >= -14 && exp <= 15) {
    // Normal f16 candidate: the 52-bit mantissa's low 42 bits must be zero.
    if (lo === 0 && (hi & 0x3ff) === 0) bits = (sign << 15) | ((exp + 15) << 10) | ((hi >>> 10) & 0x3ff);
  } else if (exp < -14) {
    // Subnormal f16 candidate: v = ±f * 2^-24 with integer f in [1, 1023].
    const f = Math.abs(v) * 2 ** 24;
    if (Number.isInteger(f) && f >= 1 && f <= 1023) bits = (sign << 15) | f;
  }
  if (bits === null) return null;
  return decodeFloat16(bits) === v ? bits : null; // belt-and-braces round-trip check
}

function decodeFloat16(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return sign * f * 2 ** -24;
  if (e === 31) return f === 0 ? sign * Infinity : NaN;
  return sign * (1024 + f) * 2 ** (e - 25);
}

function encodeHead(major, arg) {
  if (!Number.isSafeInteger(arg) || arg < 0) throw new Error("cborEncodeCde: argument out of range");
  const mt = major << 5;
  if (arg < 24) return Uint8Array.of(mt | arg);
  if (arg <= 0xff) return Uint8Array.of(mt | 24, arg);
  if (arg <= 0xffff) return Uint8Array.of(mt | 25, arg >>> 8, arg & 0xff);
  if (arg <= 0xffffffff) return Uint8Array.of(mt | 26, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff);
  const hi = Math.floor(arg / 2 ** 32);
  const lo = arg >>> 0;
  return Uint8Array.of(
    mt | 27,
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff
  );
}

function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Decode CBOR bytes. STRICT by default: the decoder REJECTS input that is not in
 * RFC 8949 §4.2.1 canonical form (non-minimal arguments, unsorted or duplicate map
 * keys, indefinite lengths, tags, simple values other than false/true/null,
 * non-shortest floats, non-finite floats, trailing bytes) — a consumed production
 * that is not deterministic-encoding bytes is refused, fail closed.
 * Maps decode to JS Map (keys: integer|string) so the CBOR-LD detokenizer can map
 * integer tokens back to terms; use decodeCborLd for the full production rule.
 */
export function cborDecodeCde(bytes, { strict = true } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new Error("cborDecodeCde: input must be a Uint8Array");
  const st = { bytes, pos: 0, strict };
  const value = readItem(st);
  if (st.pos !== bytes.length) throw new Error("cborDecodeCde: trailing bytes after top-level item");
  return value;
}

function readItem(st) {
  const ib = readU8(st);
  const major = ib >>> 5;
  const ai = ib & 0x1f;

  if (major === 7) return readMajor7(st, ai);

  const arg = readArg(st, ai, major);
  switch (major) {
    case 0:
      return arg;
    case 1:
      return -1 - arg;
    case 2: {
      const out = readBytes(st, arg);
      return out.slice(); // detached copy
    }
    case 3: {
      const raw = readBytes(st, arg);
      return utf8DecodeStrict(raw);
    }
    case 4: {
      const out = new Array(arg);
      for (let i = 0; i < arg; i += 1) out[i] = readItem(st);
      return out;
    }
    case 5: {
      const map = new Map();
      let prevKeyBytes = null;
      for (let i = 0; i < arg; i += 1) {
        const keyStart = st.pos;
        const key = readItem(st);
        const keyBytes = st.bytes.subarray(keyStart, st.pos);
        if (typeof key !== "number" && typeof key !== "string") {
          throw new Error("cborDecodeCde: map keys must be integers or strings (UM CBOR-LD profile)");
        }
        if (typeof key === "number" && !Number.isSafeInteger(key)) {
          throw new Error("cborDecodeCde: non-integer map key");
        }
        if (st.strict && prevKeyBytes !== null && compareBytes(prevKeyBytes, keyBytes) >= 0) {
          throw new Error("cborDecodeCde: map keys not in canonical bytewise order (or duplicate) — not CDE");
        }
        if (map.has(key)) throw new Error("cborDecodeCde: duplicate map key");
        prevKeyBytes = keyBytes.slice();
        map.set(key, readItem(st));
      }
      return map;
    }
    case 6:
      throw new Error("cborDecodeCde: tags are not used by the UM CBOR-LD profile (fail closed)");
    default:
      throw new Error(`cborDecodeCde: unsupported major type ${major}`);
  }
}

function readMajor7(st, ai) {
  if (ai === 20) return false;
  if (ai === 21) return true;
  if (ai === 22) return null;
  if (ai === 23) throw new Error("cborDecodeCde: undefined is not a JSON-tree value (fail closed)");
  if (ai === 25) {
    const h = (readU8(st) << 8) | readU8(st);
    const v = decodeFloat16(h);
    if (!Number.isFinite(v)) throw new Error("cborDecodeCde: non-finite float (fail closed)");
    return v;
  }
  if (ai === 26) {
    const raw = readBytes(st, 4);
    const v = new DataView(raw.buffer, raw.byteOffset, 4).getFloat32(0);
    if (!Number.isFinite(v)) throw new Error("cborDecodeCde: non-finite float (fail closed)");
    if (st.strict && tryFloat16Bits(v) !== null) throw new Error("cborDecodeCde: float not in shortest form — not CDE");
    return v;
  }
  if (ai === 27) {
    const raw = readBytes(st, 8);
    const v = new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0);
    if (!Number.isFinite(v)) throw new Error("cborDecodeCde: non-finite float (fail closed)");
    if (st.strict) {
      const dv4 = new DataView(new ArrayBuffer(4));
      dv4.setFloat32(0, v);
      if (dv4.getFloat32(0) === v) throw new Error("cborDecodeCde: float not in shortest form — not CDE");
    }
    return v;
  }
  if (ai === 31) throw new Error("cborDecodeCde: indefinite lengths are prohibited by CDE");
  throw new Error(`cborDecodeCde: unsupported simple value (ai=${ai})`);
}

function readArg(st, ai, major) {
  if (ai < 24) return ai;
  if (ai === 24) {
    const v = readU8(st);
    if (st.strict && v < 24) throw new Error("cborDecodeCde: non-minimal argument encoding — not CDE");
    return v;
  }
  if (ai === 25) {
    const v = (readU8(st) << 8) | readU8(st);
    if (st.strict && v <= 0xff) throw new Error("cborDecodeCde: non-minimal argument encoding — not CDE");
    return v;
  }
  if (ai === 26) {
    const v = ((readU8(st) << 24) | (readU8(st) << 16) | (readU8(st) << 8) | readU8(st)) >>> 0;
    if (st.strict && v <= 0xffff) throw new Error("cborDecodeCde: non-minimal argument encoding — not CDE");
    return v;
  }
  if (ai === 27) {
    const hi = ((readU8(st) << 24) | (readU8(st) << 16) | (readU8(st) << 8) | readU8(st)) >>> 0;
    const lo = ((readU8(st) << 24) | (readU8(st) << 16) | (readU8(st) << 8) | readU8(st)) >>> 0;
    const v = hi * 2 ** 32 + lo;
    if (!Number.isSafeInteger(v)) throw new Error("cborDecodeCde: integer exceeds the safe JSON-tree range");
    if (st.strict && v <= 0xffffffff) throw new Error("cborDecodeCde: non-minimal argument encoding — not CDE");
    return v;
  }
  if (ai === 31) throw new Error(`cborDecodeCde: indefinite length prohibited by CDE (major ${major})`);
  throw new Error("cborDecodeCde: reserved additional-information value");
}

function readU8(st) {
  if (st.pos >= st.bytes.length) throw new Error("cborDecodeCde: unexpected end of input");
  return st.bytes[st.pos++];
}

function readBytes(st, n) {
  if (st.pos + n > st.bytes.length) throw new Error("cborDecodeCde: unexpected end of input");
  const out = st.bytes.subarray(st.pos, st.pos + n);
  st.pos += n;
  return out;
}

function utf8DecodeStrict(bytes) {
  // TextDecoder with fatal:true rejects ill-formed UTF-8 (RFC 8949 §5.3.1 posture).
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// ===========================================================================
// 2) Context integrity (O1.7) + term-token table derivation.
//    The table is DERIVED from the pinned context bytes at runtime — never
//    hardcoded — and derivation REFUSES to run if the multihash does not match
//    the pin (tokenization correctness depends on byte-identical context).
// ===========================================================================

/** The pinned multihash of the v0.4 context (multibase base58btc, sha2-256 / 0x12). */
export const UM_V04_CONTEXT_MULTIHASH = feature_PINNED_CONTEXT_MULTIHASH;

/** Exact pinned bytes of the v0.4 versioned-namespace context document (vendored). */
export function pinnedContextBytes() {
  return base64ToBytes(feature_PINNED_CONTEXT_B64);
}

/** O1.7 hash computation: sha2-256 multihash (fn 0x12, len 0x20) of the EXACT bytes,
 *  expressed as a multibase base58btc string (z prefix). */
export async function contextMultihashB58(contextBytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", contextBytes));
  const mh = new Uint8Array(2 + digest.length);
  mh[0] = 0x12; // multihash fn code: sha2-256 (REQUIRED for v0.4 — O1.7)
  mh[1] = 0x20; // digest length 32
  mh.set(digest, 2);
  return `z${base58btcEncode(mh)}`;
}

// Fixed keyword tokens (demo-profile; the real CBOR-LD registry differs — PREVIEW label).
// Keywords are format machinery, not context terms, so they get stable low tokens.
const KEYWORD_TOKENS = Object.freeze([
  ["@context", 0],
  ["@id", 1],
  ["@type", 2],
  ["@value", 3],
  ["@language", 4],
  ["@version", 5],
  ["@vocab", 6],
]);

// Term tokens start here (keyword space below is reserved).
const TERM_TOKEN_BASE = 100;

// Demo-profile context-identifier registry: the pinned v0.4 context URL <-> integer id.
// (O1.4: "The contextReference is carried as a context identifier".)
const CONTEXT_ID_REGISTRY = Object.freeze([[UM_V04_CONTEXT, 1]]);

/**
 * Derive the UM term-token table from the pinned context document (O1.4/O1.7).
 * VERIFIES the multihash over the exact bytes FIRST — fail closed on mismatch.
 * Deterministic: terms are the non-keyword keys of the context's @context map,
 * sorted by UTF-8 bytes, tokens assigned from TERM_TOKEN_BASE upward.
 * Returns { termToToken, tokenToTerm, contextUrlToId, idToContextUrl, multihash, termCount }.
 */
export async function deriveTermTokenTable({ contextBytes, expectedMultihash } = {}) {
  const bytes = contextBytes ?? pinnedContextBytes();
  const pin = expectedMultihash ?? UM_V04_CONTEXT_MULTIHASH;
  const mh = await contextMultihashB58(bytes);
  if (mh !== pin) {
    throw new Error(
      `context integrity failure (O1.7): computed multihash ${mh} != pinned ${pin} — ` +
        "refusing to derive or apply a term-token table (fail closed)"
    );
  }
  let doc;
  try {
    doc = JSON.parse(utf8Decode(bytes));
  } catch (e) {
    throw new Error(`pinned context is not valid JSON: ${e.message}`);
  }
  const ctx = doc ? doc["@context"] : null;
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) {
    throw new Error("pinned context document has no @context term map");
  }
  const terms = Object.keys(ctx)
    .filter((k) => !k.startsWith("@"))
    .sort(compareUtf8);
  const termToToken = new Map(KEYWORD_TOKENS);
  const tokenToTerm = new Map(KEYWORD_TOKENS.map(([k, t]) => [t, k]));
  let next = TERM_TOKEN_BASE;
  for (const term of terms) {
    termToToken.set(term, next);
    tokenToTerm.set(next, term);
    next += 1;
  }
  const contextUrlToId = new Map(CONTEXT_ID_REGISTRY);
  const idToContextUrl = new Map(CONTEXT_ID_REGISTRY.map(([u, i]) => [i, u]));
  return Object.freeze({ termToToken, tokenToTerm, contextUrlToId, idToContextUrl, multihash: mh, termCount: terms.length });
}

function compareUtf8(a, b) {
  return compareBytes(utf8Encode(a), utf8Encode(b));
}

let pinnedTablePromise = null;
/** Cached table derived from the vendored pinned context (multihash-verified). */
export function getPinnedTermTokenTable() {
  if (!pinnedTablePromise) pinnedTablePromise = deriveTermTokenTable();
  return pinnedTablePromise;
}

// ===========================================================================
// 3) CBOR-LD production rule (O1.4): tokenize term keys + context identifier,
//    emit as deterministic CBOR; consumption reverses the mapping exactly.
// ===========================================================================

function tokenizeDocument(value, table) {
  if (Array.isArray(value)) return value.map((v) => tokenizeDocument(v, table));
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out = new Map();
    for (const [k, v] of Object.entries(value)) {
      const token = table.termToToken.get(k);
      const key = token !== undefined ? token : k;
      out.set(key, k === "@context" ? tokenizeContextValue(v, table) : tokenizeDocument(v, table));
    }
    return out;
  }
  return value; // primitives (and byte strings) travel literal — only KEYS are tokenized
}

function tokenizeContextValue(v, table) {
  // O1.4: the contextReference is carried as a context IDENTIFIER, not inlined terms.
  // UM-profile scope: string URL(s) only; inline object contexts are out of profile
  // (the pinned-context discipline of O1.7 forbids substituting term definitions).
  if (typeof v === "string") return table.contextUrlToId.get(v) ?? v;
  if (Array.isArray(v)) {
    return v.map((el) => {
      if (typeof el === "string") return table.contextUrlToId.get(el) ?? el;
      throw new Error("CBOR-LD (UM profile): non-string @context entries are out of profile (O1.7 pinned-context discipline)");
    });
  }
  throw new Error("CBOR-LD (UM profile): @context must be a string or array of strings");
}

function detokenizeDocument(value, table) {
  if (Array.isArray(value)) return value.map((v) => detokenizeDocument(v, table));
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value.entries()) {
      let term;
      if (typeof k === "number") {
        term = table.tokenToTerm.get(k);
        if (term === undefined) {
          throw new Error(`CBOR-LD decode: unknown term token ${k} — context version mismatch (fail closed, O1.4/O1.7)`);
        }
      } else {
        term = k;
      }
      if (Object.prototype.hasOwnProperty.call(out, term)) {
        throw new Error(`CBOR-LD decode: duplicate abstract property ${JSON.stringify(term)}`);
      }
      out[term] = term === "@context" ? detokenizeContextValue(v, table) : detokenizeDocument(v, table);
    }
    return out;
  }
  return value;
}

function detokenizeContextValue(v, table) {
  const one = (el) => {
    if (typeof el === "number") {
      const url = table.idToContextUrl.get(el);
      if (url === undefined) throw new Error(`CBOR-LD decode: unknown context identifier ${el} (fail closed, O1.7)`);
      return url;
    }
    if (typeof el === "string") return el;
    throw new Error("CBOR-LD decode: malformed context reference");
  };
  return Array.isArray(v) ? v.map(one) : one(v);
}

/**
 * PRODUCTION (encode) — O1.4: begin with the JSON-LD document, map each defined term
 * to its integer token using the pinned context, emit as deterministic CBOR.
 * Returns the wire bytes (media type application/um+cbor-ld).
 */
export async function encodeCborLd(doc, { table } = {}) {
  const t = table ?? (await getPinnedTermTokenTable());
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("encodeCborLd: a manifest document (JSON object) is required");
  }
  return cborEncodeCde(tokenizeDocument(doc, t));
}

/**
 * CONSUMPTION (decode) — O1.4: read the context identifier, reverse the integer-to-term
 * mapping, reconstruct the JSON-LD document; interpreting it under O1.3 yields the
 * abstract manifest. STRICT: refuses non-canonical CBOR and unknown tokens (fail closed).
 */
export async function decodeCborLd(bytes, { table, strict = true } = {}) {
  const t = table ?? (await getPinnedTermTokenTable());
  return detokenizeDocument(cborDecodeCde(bytes, { strict }), t);
}

// ===========================================================================
// 4) Per-production signing (O1.4 candidate rule / O1.5).
//    Signing input = CBOR-LD document minus the Base §1.6.3 exclusions, encoded
//    under RFC 8949 §4.2.1 CDE (the TOKENIZED form — the signature is bound to
//    the context version that fixes the token mapping, hence the O1.7 gate).
// ===========================================================================

/** Compute the CBOR-LD signing input bytes for a manifest document. */
export async function computeCborLdSigningInput(doc, { table } = {}) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("computeCborLdSigningInput: a manifest document is required");
  }
  const unsigned = {};
  for (const [k, v] of Object.entries(doc)) {
    if (SIGNING_INPUT_EXCLUDED_KEYS.includes(k)) continue;
    unsigned[k] = v;
  }
  return encodeCborLd(unsigned, { table });
}

/**
 * Sign a manifest document under the CBOR-LD production rule (O1.4 candidate).
 * Returns a NEW document carrying the signature member (same members as Profile A,
 * with canonicalization "CBOR-RFC8949-CDE"). Options: keyRef, created (pass null to
 * omit), embedPublicKey (default true), table.
 */
export async function attachSignatureCborLd(doc, privateKeyInput, opts = {}) {
  const table = opts.table ?? (await getPinnedTermTokenTable());
  const privateKey = await importPrivateKey(privateKeyInput);
  const rawPublicKey = await derivePublicKeyRaw(privateKey);
  const spki = rawPublicKeyToSpki(rawPublicKey);
  const didKey = publicKeyToDidKey(rawPublicKey);
  const keyRef = opts.keyRef ?? `${didKey}#${didKey.slice("did:key:".length)}`;
  const created = opts.created === null ? undefined : opts.created ?? new Date().toISOString();
  const embed = opts.embedPublicKey !== false;

  const payload = await computeCborLdSigningInput(doc, { table });
  const sigBytes = await signBytes(payload, privateKey);

  const signature = {
    algorithm: PROFILE_CBOR_CDE.algorithm,
    canonicalization: PROFILE_CBOR_CDE.canonicalization,
    keyRef,
    ...(created !== undefined ? { created } : {}),
    ...(embed ? { publicKeySpkiB64: bytesToBase64(spki) } : {}),
    value: bytesToBase64Url(sigBytes),
  };
  return { ...doc, signature };
}

/**
 * Verify a CBOR-LD-production manifest — from WIRE BYTES (preferred: verifies against
 * the bytes actually consumed, per O1.6) or from an already-consumed document.
 * Mirrors the Profile A verifier ladder, transposed to this production:
 *   1. profile pair MUST be "Ed25519" + "CBOR-RFC8949-CDE" — any other pair (including
 *      a JSON-LD Profile A signature that traveled inside a re-encoding) is
 *      "unsupported-profile", NEVER reinterpreted (Base §1.6.5 / O1.4 prohibited
 *      implementation: cross-production verification is forbidden);
 *   2. key ladder: embedded publicKeySpkiB64 first-class; keyRef<->embedded-key
 *      consistency when offline-derivable (Section 1.6.4, reused);
 *   3. recompute the signing input FROM THE CONSUMED PRODUCTION (parse -> remove
 *      exclusions -> re-encode deterministically) and verify Ed25519 over it.
 * Returns { ok, reason, checks, manifest }.
 */
export async function verifyManifestCborLd(bytesOrDoc, opts = {}) {
  const checks = {
    profilePair: false,
    signingInputRecomputed: false,
    keySource: "none",
    keyRefResolution: "unresolved",
    keyRefConsistency: "not-applicable",
    ed25519Verified: false,
  };
  const table = opts.table ?? (await getPinnedTermTokenTable());

  let doc;
  if (bytesOrDoc instanceof Uint8Array) {
    try {
      doc = await decodeCborLd(bytesOrDoc, { table });
    } catch (e) {
      return { ok: false, reason: `cbor-ld-consumption-failed: ${e.message}`, checks, manifest: null };
    }
  } else {
    doc = bytesOrDoc;
  }

  if (!doc || typeof doc !== "object" || !doc.signature || typeof doc.signature !== "object") {
    return { ok: false, reason: "missing-signature", checks, manifest: doc ?? null };
  }
  const sig = doc.signature;
  if (sig.algorithm !== PROFILE_CBOR_CDE.algorithm || sig.canonicalization !== PROFILE_CBOR_CDE.canonicalization) {
    // O1.4/O1.6: a signature bound to ANOTHER production's bytes must not verify here.
    return { ok: false, reason: "unsupported-profile", checks, manifest: doc };
  }
  if (typeof sig.value !== "string" || sig.value.length === 0) {
    return { ok: false, reason: "missing-signature-value", checks, manifest: doc };
  }
  checks.profilePair = true;

  // Key ladder (embedded key first-class; Section 1.6.4 consistency).
  const embedded = typeof sig.publicKeySpkiB64 === "string" ? sig.publicKeySpkiB64 : null;
  const keyRef = typeof sig.keyRef === "string" ? sig.keyRef : null;
  let publicKeyInput = null;
  if (embedded) {
    publicKeyInput = base64ToBytes(embedded);
    checks.keySource = "embedded-spki";
    if (keyRef) {
      const consistency = await checkKeyRefConsistency(keyRef, publicKeyInput, opts);
      checks.keyRefResolution = consistency.keyRefResolution;
      checks.keyRefConsistency =
        consistency.keyRefResolution === "resolved"
          ? consistency.consistent
            ? "consistent"
            : "mismatch"
          : "unresolved-embedded-key-stands";
      if (!consistency.consistent) {
        return { ok: false, reason: "keyref-embedded-key-mismatch", checks, manifest: doc };
      }
    }
  } else if (keyRef) {
    const resolved = await resolveKeyRefOffline(keyRef, opts);
    checks.keyRefResolution = resolved.resolution;
    if (resolved.resolution !== "resolved") {
      return { ok: false, reason: "keyref-unresolvable-and-no-embedded-key", checks, manifest: doc };
    }
    publicKeyInput = resolved.rawPublicKey;
    checks.keySource = "keyref-derived";
  } else {
    return { ok: false, reason: "no-key-material", checks, manifest: doc };
  }

  const payload = await computeCborLdSigningInput(doc, { table });
  checks.signingInputRecomputed = true;

  let ok = false;
  try {
    ok = await verifyBytes(payload, sig.value, publicKeyInput);
  } catch {
    ok = false;
  }
  checks.ed25519Verified = ok;
  return { ok, reason: ok ? "verified" : "signature-verification-failed", checks, manifest: doc };
}

// ===========================================================================
// 5) Production/consumption helpers for the reference (JSON-LD) encoding, so the
//    harness treats both encodings uniformly as BYTES on a wire.
// ===========================================================================

/** JSON-LD production rule (O1.3) wire bytes (media type application/um+ld+json). */
export function produceJsonLd(doc) {
  return utf8Encode(JSON.stringify(doc));
}

/** JSON-LD consumption: parse the wire bytes back to the document. */
export function consumeJsonLd(bytes) {
  return JSON.parse(utf8Decode(bytes));
}

// ===========================================================================
// 6) Encoding-agnostic evaluation at the abstract-model boundary.
//    The stages MIRROR evaluateConsentGating field-for-field (same
//    receipt surface, same warning codes, same ordering) with ONE swap: the
//    Verify-stage signature check is the PER-PRODUCTION verifier for the
//    production actually consumed (O1.6) instead of hardwired Profile A.
//    The consent stage itself is REUSED (evaluateConsentStage /
//    validateConsentStructural) — not re-implemented. verify.mjs §F
//    ANCHORS this mirror byte-exact against the landed evaluateConsentGating
//    on the JSON-LD path, so the mirror cannot drift silently.
// ===========================================================================

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isIsoDateTime(v) {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

/** v0.4 envelope shape check — mirrors Arrive-gate envelopeErrors (kept
 *  private there; anchored byte-exact by verify.mjs so it cannot drift). */
function featureEnvelopeErrors(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["manifest must be an object"];
  const ctx = manifest["@context"];
  const hasV04 = ctx === UM_V04_CONTEXT || (Array.isArray(ctx) && ctx.includes(UM_V04_CONTEXT));
  if (!hasV04) errors.push(`@context must include ${UM_V04_CONTEXT} (Section 1.2.1)`);
  if (!isNonEmptyString(manifest["@id"])) errors.push("Missing @id");
  const t = manifest["@type"];
  if (!(t === "um:Manifest" || (Array.isArray(t) && t.includes("um:Manifest")))) errors.push("Missing um:Manifest in @type");
  if (manifest.manifestVersion !== "0.4") errors.push("manifestVersion must be 0.4");
  if (!isNonEmptyString(manifest.subject)) errors.push("Missing subject");
  if (!isIsoDateTime(manifest.issuedAt)) errors.push("issuedAt must be an ISO 8601 date-time");
  if (!isIsoDateTime(manifest.expiresAt)) errors.push("expiresAt must be an ISO 8601 date-time");
  return errors;
}

/**
 * Evaluate a CONSUMED manifest (abstract model) with an injected per-production
 * signature report. Field-for-field the receipt surface:
 *   { "@type":"um:Receipt", manifestId, outcome, signatureCheck, freshnessCheck,
 *     facetStatuses, consentStatuses, warnings }
 * omitProcessedAt semantics: NO processedAt and NO receiptId are emitted — the
 * receipt is fully deterministic under a pinned context.now.
 */
export function evaluateConsumedManifest(consumed, context = {}, signatureReport = null) {
  const nowMs = isIsoDateTime(context.now) ? Date.parse(context.now) : Date.now();
  const manifestId =
    consumed && typeof consumed === "object" && isNonEmptyString(consumed["@id"]) ? consumed["@id"] : "(unknown)";
  const warnings = [];
  const receipt = {
    "@type": "um:Receipt",
    manifestId,
    outcome: "rejected",
    signatureCheck: "not-evaluated",
    freshnessCheck: "not-evaluated",
    facetStatuses: [],
    consentStatuses: [],
    warnings,
  };
  const finish = (outcome) => {
    receipt.outcome = outcome;
    return { result: outcome === "rejected" ? "reject" : "accept", receipt };
  };

  // --- Arrive/Verify: structure (envelope + consent shape; consent shapes REUSED) ---
  const structural = [...featureEnvelopeErrors(consumed), ...validateConsentStructural(consumed).errors];
  if (structural.length > 0) {
    warnings.push({ code: "um:reason:structure:malformed", message: `Verify stage: ${structural.join("; ")}` });
    return finish("rejected");
  }

  // --- Arrive/Verify: signature — the PER-PRODUCTION report (O1.6: verified against
  //     the bytes of the production actually consumed; computed by the caller) --------
  const sig = consumed.signature;
  if (!sig || typeof sig !== "object") {
    warnings.push({ code: "um:reason:crypto:signature-missing", message: "Verify stage: missing signature" });
    return finish("rejected");
  }
  const sigReport = signatureReport ?? { ok: false, reason: "not-evaluated" };
  if (!sigReport.ok) {
    receipt.signatureCheck = sigReport.reason === "unsupported-profile" ? "unsupported-profile" : "invalid";
    warnings.push({ code: "um:reason:crypto:signature-invalid", message: `Verify stage: ${sigReport.reason}` });
    return finish("rejected");
  }
  receipt.signatureCheck = "valid";

  // --- Arrive/Verify: freshness at the PINNED now (§3.1.2; 60s skew) ----------------
  const SKEW_MS = 60_000;
  const issuedMs = Date.parse(consumed.issuedAt);
  const expiresMs = Date.parse(consumed.expiresAt);
  if (Number.isFinite(issuedMs) && issuedMs - nowMs > SKEW_MS) {
    receipt.freshnessCheck = "stale";
    warnings.push({ code: "um:reason:freshness:stale", message: "Verify stage: issuedAt more than 60s in the future" });
    return finish("rejected");
  }
  if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
    receipt.freshnessCheck = "expired";
    warnings.push({ code: "um:reason:freshness:expired", message: "Verify stage: manifest expired" });
    return finish("rejected");
  }
  receipt.freshnessCheck = "fresh";

  // --- Stage-4 Consent — REUSED engine (not re-implemented) ------------------
  const stage = evaluateConsentStage(consumed, context);
  receipt.facetStatuses = stage.facetStatuses;
  receipt.consentStatuses = stage.consentStatuses;
  for (const cs of stage.consentStatuses) {
    if (cs.status !== "granted") {
      warnings.push({ code: `um:reason:consent:${cs.status}`, message: `Consent stage: ${cs.consentRef} ⇒ ${cs.status} (${cs.reason})` });
    }
  }
  for (const fs of stage.facetStatuses) {
    if (fs.status === "consent-missing") {
      warnings.push({ code: "um:reason:consent:consent-missing", message: `Consent stage: facet ${fs.facetId} has no governing consent ⇒ consent-missing, not processed` });
    }
  }

  // --- Compose the outcome -----------------------------------------------------------
  if (stage.notProcessed.length > 0) return finish("accepted-partial");
  return finish("accepted");
}

/**
 * Consume WIRE BYTES through the named production rule, verify the signature against
 * the consumed production (O1.6), then evaluate the abstract model.
 * encoding: "json-ld" | "cbor-ld".
 * Returns { encoding, wireSize, consumed, signatureReport, result, receipt }.
 */
export async function evaluateProduction(bytes, { encoding, context = {}, table } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new Error("evaluateProduction: wire bytes (Uint8Array) required");
  let consumed = null;
  let signatureReport;
  if (encoding === "json-ld") {
    try {
      consumed = consumeJsonLd(bytes);
    } catch (e) {
      signatureReport = { ok: false, reason: `json-ld-consumption-failed: ${e.message}`, checks: {} };
    }
    if (consumed) {
      signatureReport =
        consumed.signature && typeof consumed.signature === "object"
          ? await verifyManifestProfileA(consumed)
          : { ok: false, reason: "missing-signature", checks: {} };
    }
  } else if (encoding === "cbor-ld") {
    const v = await verifyManifestCborLd(bytes, { table });
    consumed = v.manifest;
    signatureReport = v;
  } else {
    throw new Error(`evaluateProduction: unsupported encoding ${JSON.stringify(encoding)} — evaluators reject representations they do not support (O1.2)`);
  }
  const { result, receipt } = evaluateConsumedManifest(consumed, context, signatureReport);
  return { encoding, wireSize: bytes.length, consumed, signatureReport, result, receipt };
}

// ===========================================================================
// 7) Cross-encoding format-independence harness.
// ===========================================================================

/**
 * Produce the SAME abstract manifest through BOTH production rules, each signed
 * under ITS OWN rule with the SAME key (per-production signing, O1.5). Any
 * placeholder/existing signature on the input is stripped first.
 * Returns { jsonLd: { manifest, bytes }, cborLd: { manifest, bytes } }.
 */
export async function signBothProductions(unsignedDoc, privateKeyInput, opts = {}) {
  if (!unsignedDoc || typeof unsignedDoc !== "object") throw new Error("signBothProductions: manifest document required");
  const base = {};
  for (const [k, v] of Object.entries(unsignedDoc)) {
    if (k === "signature") continue; // placeholder slots never travel into signing
    base[k] = v;
  }
  const signOpts = {};
  if (opts.keyRef !== undefined) signOpts.keyRef = opts.keyRef;
  if (opts.created !== undefined) signOpts.created = opts.created;
  const jsonManifest = await attachSignatureProfileA(base, privateKeyInput, signOpts);
  const cborManifest = await attachSignatureCborLd(base, privateKeyInput, { ...signOpts, table: opts.table });
  return {
    jsonLd: { manifest: jsonManifest, bytes: produceJsonLd(jsonManifest) },
    cborLd: { manifest: cborManifest, bytes: await encodeCborLd(cborManifest, { table: opts.table }) },
  };
}

/**
 * Receipt equivalence with omitProcessedAt semantics: strip processedAt/receiptId
 * (neither is emitted by evaluateConsumedManifest — the strip is defensive), JCS-
 * canonicalize both receipts, BYTE-compare. Returns { equal, bytesA, bytesB }.
 */
export function compareReceipts(receiptA, receiptB, { omit = ["processedAt", "receiptId"] } = {}) {
  const strip = (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (omit.includes(k)) continue;
      out[k] = v;
    }
    return out;
  };
  const bytesA = jcsCanonicalizeToBytes(strip(receiptA));
  const bytesB = jcsCanonicalizeToBytes(strip(receiptB));
  return { equal: bytesEqual(bytesA, bytesB), bytesA, bytesB };
}

/** Order-insensitive-for-maps, order-sensitive-for-arrays deep equality (abstract-model
 *  equality per INFRA maps; numbers compared with Object.is so round-trips are exact). */
export function deepEqual(a, b) {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return bytesEqual(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a.entries()) {
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Run ONE format-independence scenario end-to-end:
 *   abstract manifest -> both productions (each signed under its own rule) ->
 *   consume + verify + evaluate BOTH -> byte-compare receipts; plus the CBOR-LD
 *   lossless round-trip check on the signed document.
 * Returns a UI/verifier-ready record (see buildFormatIndependencePanel).
 */
export async function runFormatIndependenceScenario({ name, unsignedManifest, evaluationContext = {}, privateKeyInput, table } = {}) {
  const productions = await signBothProductions(unsignedManifest, privateKeyInput, {
    created: typeof unsignedManifest?.issuedAt === "string" ? unsignedManifest.issuedAt : undefined,
    table,
  });
  const evalJson = await evaluateProduction(productions.jsonLd.bytes, { encoding: "json-ld", context: evaluationContext });
  const evalCbor = await evaluateProduction(productions.cborLd.bytes, { encoding: "cbor-ld", context: evaluationContext, table });
  const receipts = compareReceipts(evalJson.receipt, evalCbor.receipt);
  const decodedCbor = await decodeCborLd(productions.cborLd.bytes, { table });
  const roundTripLossless = deepEqual(decodedCbor, productions.cborLd.manifest);
  return {
    name: name ?? "(scenario)",
    preview: true,
    roundTripLossless,
    receiptsEqual: receipts.equal,
    outcome: evalJson.receipt.outcome,
    signatureChecks: { jsonLd: evalJson.signatureReport.reason, cborLd: evalCbor.signatureReport.reason },
    sizes: { jsonLd: productions.jsonLd.bytes.length, cborLd: productions.cborLd.bytes.length },
    productions,
    evaluations: { jsonLd: evalJson, cborLd: evalCbor },
    receiptCanonicalBytes: receipts.bytesA,
  };
}

/**
 * UI-ready "format independence" panel record for the demo toggle (task deliverable 4):
 * both wire payloads (base64 + sizes side-by-side) and the matching receipts. Pure
 * data — the page renders it; wiring lines are documented in the result note.
 */
export function buildFormatIndependencePanel(scenarioResult) {
  const s = scenarioResult;
  const saved = s.sizes.jsonLd > 0 ? Math.round((1 - s.sizes.cborLd / s.sizes.jsonLd) * 100) : 0;
  return {
    label: feature_CBOR_LD_PREVIEW.label,
    preview: true,
    scenario: s.name,
    receiptsEqual: s.receiptsEqual,
    roundTripLossless: s.roundTripLossless,
    outcome: s.outcome,
    signatureChecks: s.signatureChecks,
    wire: {
      jsonLd: { mediaType: "application/um+ld+json", size: s.sizes.jsonLd, payloadB64: bytesToBase64(s.productions.jsonLd.bytes) },
      cborLd: { mediaType: feature_CBOR_LD_PREVIEW.media_type, size: s.sizes.cborLd, payloadB64: bytesToBase64(s.productions.cborLd.bytes) },
      savedPercent: saved,
    },
    receipt: s.evaluations.jsonLd.receipt,
  };
}
