// byte/string codecs shared by the signing library.
//
// Zero-dependency, environment-agnostic (browser + Node) helpers. Everything in
// web/signing/ is plain ESM with no imports outside this directory, so the whole
// library loads in a browser <script type="module"> AND in Node (`node --input-type`
// or `.mjs`) without a bundler. Node's Buffer is deliberately NOT used anywhere.
//
// Codecs provided:
//   - UTF-8            (TextEncoder/TextDecoder — the RFC 8785 §3.2.4 output encoding)
//   - hex              (lowercase; used by the RFC 8785 / RFC 8032 test vectors)
//   - base64 standard  (WITH padding — UM Signature Profile A `publicKeySpkiB64`)
//   - base64url        (WITHOUT padding — UM Signature Profile A `signature.value`,
//                        RFC 4648 §5, matches Node's 'base64url' and JOSE usage)
//   - base58btc        (Bitcoin alphabet — multibase 'z' payload for did:key /
//                        publicKeyMultibase / did:pkh solana addresses)

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_LOOKUP = (() => {
  const m = new Map();
  for (let i = 0; i < B58_ALPHABET.length; i++) m.set(B58_ALPHABET[i], i);
  return m;
})();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Encode a JS string to UTF-8 bytes (RFC 8785 §3.2.4 final step). */
export function utf8Encode(str) {
  return textEncoder.encode(str);
}

/** Decode UTF-8 bytes to a JS string (throws on invalid UTF-8). */
export function utf8Decode(bytes) {
  return textDecoder.decode(bytes);
}

/** bytes -> lowercase hex string. */
export function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** hex string (case-insensitive, optional whitespace) -> Uint8Array. */
export function hexToBytes(hex) {
  const clean = String(hex).replace(/\s+/g, "").toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new Error(`Invalid hex string: ${String(hex).slice(0, 32)}...`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// btoa/atob exist in browsers and in Node >= 16 (globalThis). They operate on
// "binary strings"; we bridge Uint8Array <-> binary string explicitly.
function bytesToBinaryString(bytes) {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return s;
}

function binaryStringToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/** bytes -> standard base64 WITH padding (UM `signature.publicKeySpkiB64` form). */
export function bytesToBase64(bytes) {
  return btoa(bytesToBinaryString(bytes));
}

/** standard base64 (padding optional) -> bytes. */
export function base64ToBytes(b64) {
  return binaryStringToBytes(atob(String(b64)));
}

/** bytes -> base64url WITHOUT padding (UM `signature.value` form, RFC 4648 §5). */
export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** base64url (padding optional) -> bytes. */
export function base64UrlToBytes(b64u) {
  let s = String(b64u).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4 !== 0) s += "=";
  return binaryStringToBytes(atob(s));
}

/**
 * bytes -> base58btc (Bitcoin alphabet, leading 0x00 bytes -> leading '1's).
 * Classic byte-carry algorithm; no BigInt so it runs everywhere.
 */
export function base58btcEncode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const digits = []; // little-endian base58 digits
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

/** base58btc string -> bytes (throws on characters outside the Bitcoin alphabet). */
export function base58btcDecode(str) {
  const s = String(str);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;

  const bytes = []; // little-endian byte accumulator
  for (const ch of s) {
    const val = B58_LOOKUP.get(ch);
    if (val === undefined) throw new Error(`Invalid base58btc character: ${JSON.stringify(ch)}`);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  // leading zeros already 0-initialized; copy the accumulator big-endian after them
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/** Constant-time-ish byte equality (length + content). */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
