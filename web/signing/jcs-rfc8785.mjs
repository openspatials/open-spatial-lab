// JSON Canonicalization Scheme (JCS), RFC 8785. BYTE-EXACT core.
//
// This is the precision-critical heart of the trust spine: the Ed25519 signing input
// for UM Signature Profile A is "JCS(manifest-without-signature) as UTF-8 bytes"
// (universalmanifest spec/v0.2/SIGNATURE-PROFILE.md §4). A canonicalization bug is
// SILENT — sign and verify agree with each other until a third-party verifier
// rejects the bytes. So every rule below is pinned to the RFC and proven against the
// RFC's own reference vectors by web/signing/verify-vectors.mjs:
//
//   - §3.2.3/§3.2.4 composite object -> exact canonical string AND the exact
//     120-byte UTF-8 hex sequence printed in the RFC,
//   - §3.2.3 UTF-16 code-unit property sorting vector (7 exotic keys),
//   - Appendix B: all 21 finite IEEE-754 number samples byte-for-byte, plus the
//     NaN / Infinity MUST-error rows.
//
// RULES IMPLEMENTED (with RFC section pins):
//   Literals   §3.2.2.1  null/true/false serialized literally.
//   Strings    §3.2.2.2  ECMAScript JSON.stringify quoting: control chars U+0000..
//                        U+001F as \b \t \n \f \r or lowercase \u00xx; " and \
//                        escaped; everything else emitted as-is (no \uXXXX for
//                        non-ASCII). Lone surrogates MUST error (interop hazard).
//   Numbers    §3.2.2.3  ECMAScript Number::toString (shortest round-trip, as
//                        implemented by every modern JS engine's JSON.stringify).
//                        NaN / Infinity MUST error. -0 serializes as "0".
//   Sorting    §3.2.3    Recursive; property names compared as arrays of UTF-16
//                        code units (JS default String "<" — NOT locale, NOT code
//                        points). Array element order NEVER changes.
//   Output     §3.2.4    UTF-8 bytes (jcsCanonicalizeToBytes).
//
// DELIBERATE STRICTNESS BEYOND JSON.stringify (documented, all error paths):
//   - NaN/Infinity THROW (JSON.stringify silently emits "null" — forbidden by
//     §3.2.2.3 for a compliant JCS implementation).
//   - Lone surrogates THROW (§3.2.2.2 note: MUST terminate with an error;
//     JSON.stringify would emit a replacement escape).
//   - Values outside the JSON data model THROW instead of being silently coerced:
//     BigInt, functions, symbols, Map, Set, TypedArray/ArrayBuffer, and a
//     top-level undefined. A signing library must never silently sign "{}" where
//     the caller believed data was present.
//   - toJSON() is honored (so Date -> ISO string), and — unlike the RFC's
//     Appendix A sample code, which hands toJSON objects to plain JSON.stringify —
//     the RETURN VALUE of toJSON() is canonicalized recursively, so an
//     object-returning toJSON still gets sorted keys.
//   - Object properties whose value is undefined/function/symbol are SKIPPED and
//     array holes/undefined elements serialize as null — both exactly matching
//     ECMAScript JSON.stringify (and the universalmanifest reference
//     implementation's canonicalizeJson, which filters undefined the same way).
//
// SCOPE (honest): this canonicalizes the ECMAScript-JSON data model (the RFC's own
// basis). I-JSON input discipline (RFC 7493 — e.g. rejecting duplicate keys at
// parse time) is the PARSER's job: JSON.parse keeps the last duplicate, and JCS
// canonicalizes what the parser produced. That matches RFC 8785 §3.1.

/** Canonicalize a parsed-JSON value to the RFC 8785 canonical string. */
export function jcsCanonicalize(value) {
  if (value === undefined) {
    throw new TypeError("JCS: top-level value is undefined (not JSON data)");
  }
  let out = "";
  const append = (chunk) => {
    out += chunk;
  };
  serializeValue(value, append);
  return out;
}

/** Canonicalize to the UTF-8 byte sequence (RFC 8785 §3.2.4) — the signing input. */
export function jcsCanonicalizeToBytes(value) {
  // TextEncoder replaces lone surrogates instead of throwing, but serializeString
  // has already rejected them, so encode() here is loss-free.
  return new TextEncoder().encode(jcsCanonicalize(value));
}

function serializeValue(value, append) {
  if (value === null) {
    append("null");
    return;
  }

  switch (typeof value) {
    case "boolean":
      append(value ? "true" : "false");
      return;
    case "number":
      serializeNumber(value, append);
      return;
    case "string":
      serializeString(value, append);
      return;
    case "bigint":
      throw new TypeError("JCS: BigInt is not part of the JSON data model (RFC 8785 §3.1); represent big numbers as strings (Appendix D)");
    case "undefined":
    case "function":
    case "symbol":
      // Reached only for array elements (object properties are filtered earlier;
      // top-level undefined throws in jcsCanonicalize). JSON.stringify parity.
      append("null");
      return;
    case "object":
      break;
    default:
      throw new TypeError(`JCS: unsupported value type ${typeof value}`);
  }

  // Honor toJSON (Date etc.) but canonicalize its RESULT recursively (stricter
  // than RFC 8785 Appendix A sample code — see header).
  if (typeof value.toJSON === "function") {
    serializeValue(value.toJSON(), append);
    return;
  }

  if (Array.isArray(value)) {
    append("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) append(",");
      serializeValue(value[i], append); // §3.2.3: array element order MUST NOT change
    }
    append("]");
    return;
  }

  rejectNonJsonObject(value);

  // §3.2.3: sort own enumerable property names as UTF-16 code-unit arrays.
  // JavaScript's default Array#sort on strings is exactly this comparison.
  const keys = Object.keys(value).sort();
  append("{");
  let first = true;
  for (const key of keys) {
    const propValue = value[key];
    // JSON.stringify parity: properties with non-JSON values disappear.
    if (
      propValue === undefined ||
      typeof propValue === "function" ||
      typeof propValue === "symbol"
    ) {
      continue;
    }
    if (!first) append(",");
    first = false;
    serializeString(key, append); // §3.2.2.2 applies to property names too
    append(":");
    serializeValue(propValue, append);
  }
  append("}");
}

function rejectNonJsonObject(value) {
  // A signing library must not silently serialize non-JSON containers as "{}".
  if (value instanceof Map || value instanceof Set) {
    throw new TypeError("JCS: Map/Set are not JSON data; convert to object/array first");
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError("JCS: binary buffers are not JSON data; encode as base64/base64url string first");
  }
  if (value instanceof Date) {
    // Unreachable in practice (Date has toJSON) — kept as a tripwire in case a
    // frozen/realm-stripped Date loses its prototype chain toJSON.
    throw new TypeError("JCS: Date without toJSON; convert to ISO string first");
  }
}

// §3.2.2.3 — ECMAScript number serialization. Every modern engine's
// JSON.stringify implements Number::toString(10) with shortest-round-trip
// output (ECMA-262 7.1.12.1 incl. Note 2). Appendix B of the RFC is the proof
// harness for this exact code path (all 21 finite samples byte-for-byte).
function serializeNumber(value, append) {
  if (!Number.isFinite(value)) {
    throw new TypeError("JCS: NaN and Infinity are not permitted in JSON (RFC 8785 §3.2.2.3)");
  }
  // JSON.stringify(-0) === "0" — required by Appendix B row 8000000000000000.
  append(JSON.stringify(value));
}

// §3.2.2.2 — string serialization. JSON.stringify implements the exact
// ECMAScript QuoteJSONString algorithm the RFC references (lowercase \u00xx,
// short escapes \b \t \n \f \r, only " and \ escaped above U+001F).
function serializeString(value, append) {
  if (!isWellFormedString(value)) {
    throw new TypeError("JCS: lone surrogate in string data (RFC 8785 §3.2.2.2 requires an error)");
  }
  append(JSON.stringify(value));
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isWellFormedString(str) {
  if (typeof str.isWellFormed === "function") return str.isWellFormed();
  return !LONE_SURROGATE_RE.test(str);
}
