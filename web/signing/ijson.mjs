// I-JSON input discipline
// for the signing keystone. Closes boundary findings B1 and B2 of
//
//   B1 — large-integer (>2^53) canonical collision. Two DISTINCT JSON texts whose
//        only difference is an integer beyond 2^53 collapse to the SAME IEEE-754
//        double at parse time, hence the SAME RFC 8785 canonical bytes — one
//        signature would verify both documents. RFC 8785 §3.1 assumes I-JSON
//        (RFC 7493) input and delegates range enforcement to the input layer;
//        this module IS that input layer.
//   B2 — duplicate-key parse collision. {"a":1,"a":2} and {"a":2} both
//        JSON.parse to {a:2} (last-wins) and share canonical bytes. RFC 7493
//        §2.3 says names MUST be unique; JSON.parse does not enforce it.
//
// WHAT LIVES HERE:
//   parseIJson(text)        — strict I-JSON parse of UNTRUSTED JSON text. Exactly the
//                             RFC 8259 grammar, PLUS: duplicate object keys REJECTED
//                             (RFC 7493 §2.3), numbers REJECTED when non-finite or
//                             outside ±(2^53-1) (RFC 7493 §2.2 / RFC 8785 Appendix D:
//                             represent big numbers as strings), lone-surrogate string
//                             values REJECTED (RFC 7493 §2.1), trailing content REJECTED.
//                             Use this instead of JSON.parse in front of sign/verify
//                             whenever the manifest arrives as TEXT.
//   findUnsafeNumber(value) — walk an ALREADY-PARSED value and locate the first number
//                             outside the I-JSON safe range (or non-finite). Used by
//                             computeSigningInput({strictNumbers:true}) and by the
//                             verifier (strict by default) so an out-of-range number
//                             can never be silently signed-or-verified even when the
//                             caller parsed with plain JSON.parse.
//
// HONEST SCOPE:
//   - Precision loss in decimal FRACTIONS (e.g. "0.1000…0555" vs "0.1") is inherent
//     to the IEEE-754 double model that RFC 8785 §3.2.2.3 is defined over; I-JSON
//     accepts it. Only the INTEGER range rule is enforced here, exactly as the
//     hardening report scopes B1. Every IEEE-754 double with |x| > 2^53-1 is
//     integer-valued, so the single magnitude test covers the whole aliasing class.
//   - Value-identical spellings ("1" vs "1.0") canonicalize identically BY DESIGN
//     (RFC 8785 §3.2.2.3) — that is one value with one canonical form, not aliasing.
//
// Zero imports; browser-safe; imported by um-signature-profile-a.mjs and (for the
// emitter's sign-side guard) web/manifest/um-manifest-emitter.mjs.

/** Inclusive I-JSON safe-integer bound: 2^53 - 1 (RFC 7493 §2.2). */
export const I_JSON_MAX_SAFE_NUMBER = Number.MAX_SAFE_INTEGER;

/**
 * True when a number is UNSAFE for signing input: non-finite, or magnitude beyond
 * ±(2^53-1) where distinct mathematical integers collapse to one double.
 */
export function isUnsafeSigningNumber(n) {
  return typeof n === "number" && (!Number.isFinite(n) || Math.abs(n) > I_JSON_MAX_SAFE_NUMBER);
}

/**
 * Walk a parsed JSON-model value; return the FIRST unsafe number as
 * { path, value } (path is a "$.a.b[3]" locator) or null when the value is clean.
 * Mirrors RFC 8785 serialization coverage: follows toJSON() results (Date -> string),
 * skips object properties whose value is undefined/function/symbol (JCS skips them),
 * and inspects array elements in order. Non-number leaves are ignored — the JCS
 * serializer already throws on non-JSON data.
 */
export function findUnsafeNumber(value, path = "$") {
  if (typeof value === "number") {
    return isUnsafeSigningNumber(value) ? { path, value } : null;
  }
  if (value === null || typeof value !== "object") return null;
  if (typeof value.toJSON === "function") {
    return findUnsafeNumber(value.toJSON(), path);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findUnsafeNumber(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v === undefined || typeof v === "function" || typeof v === "symbol") continue; // JCS skips these
    const hit = findUnsafeNumber(v, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// parseIJson — strict recursive-descent I-JSON parser (RFC 8259 grammar with the
// RFC 7493 discipline JSON.parse omits). Throws TypeError with a character offset.
// ---------------------------------------------------------------------------

// JSON number token, anchored stickily at the current offset (RFC 8259 §6).
const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isWellFormedString(str) {
  if (typeof str.isWellFormed === "function") return str.isWellFormed();
  return !LONE_SURROGATE_RE.test(str);
}

/**
 * Parse UNTRUSTED JSON text under I-JSON (RFC 7493) discipline. Returns the parsed
 * value or throws TypeError naming the violation and its character offset:
 *   - duplicate object key            (RFC 7493 §2.3 — B2)
 *   - number outside ±(2^53-1)        (RFC 7493 §2.2 — B1; string-encode big numbers,
 *                                      RFC 8785 Appendix D)
 *   - non-finite number overflow      (e.g. 1e999)
 *   - lone surrogate in a string      (RFC 7493 §2.1)
 *   - malformed JSON / trailing content
 * `__proto__` is preserved as a plain OWN property (no prototype pollution), matching
 * JSON.parse and the JCS serializer's own-property coverage.
 */
export function parseIJson(text) {
  if (typeof text !== "string") {
    throw new TypeError("I-JSON: input must be a string of JSON text");
  }
  let i = 0;

  const fail = (msg, at = i) => {
    throw new TypeError(`I-JSON: ${msg} at offset ${at}`);
  };

  const skipWs = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };

  const expectLiteral = (lit, value) => {
    if (!text.startsWith(lit, i)) fail(`invalid literal (expected ${lit})`);
    i += lit.length;
    return value;
  };

  const parseString = () => {
    const start = i;
    if (text[i] !== '"') fail("expected string");
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        i += 2; // skip the escape pair; JSON.parse validates the escape below
        continue;
      }
      if (ch === '"') {
        i++;
        const token = text.slice(start, i);
        let parsed;
        try {
          parsed = JSON.parse(token); // engine-exact RFC 8259 string semantics
        } catch {
          fail("malformed string token", start);
        }
        if (!isWellFormedString(parsed)) {
          fail("lone surrogate in string (RFC 7493 §2.1 requires Unicode characters)", start);
        }
        return parsed;
      }
      i++;
    }
    return fail("unterminated string", start);
  };

  const parseNumber = () => {
    const start = i;
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(text);
    if (!m || m.index !== i) fail("malformed number", start);
    i += m[0].length;
    const value = Number(m[0]);
    if (!Number.isFinite(value)) {
      fail(`number ${m[0]} overflows to a non-finite double`, start);
    }
    if (Math.abs(value) > I_JSON_MAX_SAFE_NUMBER) {
      fail(
        `number ${m[0]} is outside the I-JSON safe range ±(2^53-1) (RFC 7493 §2.2); ` +
          "represent big numbers as strings (RFC 8785 Appendix D)",
        start
      );
    }
    return value;
  };

  const parseObject = () => {
    i++; // consume {
    const obj = {};
    const seen = new Set();
    skipWs();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    for (;;) {
      skipWs();
      const keyAt = i;
      if (text[i] !== '"') fail("expected object key string");
      const key = parseString();
      if (seen.has(key)) {
        fail(`duplicate object key ${JSON.stringify(key)} (RFC 7493 §2.3 names MUST be unique)`, keyAt);
      }
      seen.add(key);
      skipWs();
      if (text[i] !== ":") fail("expected ':' after object key");
      i++;
      const value = parseValue();
      // Own data property even for "__proto__" (never the prototype setter).
      Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return obj;
      }
      fail("expected ',' or '}' in object");
    }
  };

  const parseArray = () => {
    i++; // consume [
    const arr = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return arr;
      }
      fail("expected ',' or ']' in array");
    }
  };

  const parseValue = () => {
    skipWs();
    if (i >= text.length) fail("unexpected end of input");
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "t") return expectLiteral("true", true);
    if (c === "f") return expectLiteral("false", false);
    if (c === "n") return expectLiteral("null", null);
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    return fail(`unexpected character ${JSON.stringify(c)}`);
  };

  const value = parseValue();
  skipWs();
  if (i !== text.length) fail("unexpected trailing content");
  return value;
}
