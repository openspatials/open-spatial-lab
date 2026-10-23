// self-runnable test-vector check for the signing library.
//
//   node web/signing/verify-vectors.mjs        (from the prototype root; any cwd works)
//
// Prints PASS/FAIL per vector and exits non-zero on any failure. This runner is
// the PROOF for every claim the library makes; nothing in web/signing/ is claimed
// beyond what a vector here shows. The library modules are browser-safe; this
// RUNNER is Node-only (it reads fixture files).
//
// Vector sources (see vectors/*.json "source"/"citation" fields):
//   A/B/C/D  RFC 8785 (JCS)     — §3.2.2–§3.2.4 composite bytes, §3.2.3 sorting,
//                                  Appendix B numbers, §3.2.2.2 string rules.
//   E        RFC 8032 (Ed25519) — §7.1 TEST 1/2/3: known keys, known DETERMINISTIC
//                                  signatures, byte-for-byte.
//   F/G/H    DID methods        — did:key spec example; did:web URL rule (offline,
//                                  injected loader only); did:pkh solana/eip155.
//   I        UM Signature Profile A — shape, frozen byte-reproducible signature,
//                                  round-trip, tamper, key-substitution (1.6.4),
//                                  unsupported profile, the UM repo's own signed
//                                  fixture verified by THIS library, v0.4 input rule.
//   J        Determinism        — key-order independence, idempotence.
//
// The um-minimal-signed-manifest.fixture.jsonld file is a VERBATIM copy of
// universalmanifest conformance/v0.2/valid/minimal-signed-manifest.jsonld
// (the UM suite's own reference-signed manifest) — verifying it here proves
// interop-IN; crosscheck-um-harness.mjs proves interop-OUT.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  attachSignatureProfileA,
  base58btcEncode,
  bytesToBase64Url,
  bytesToHex,
  canonicalize,
  canonicalizeToString,
  checkKeyRefConsistency,
  computeSigningInputString,
  derivePublicKeyRaw,
  didWebToUrl,
  hexToBytes,
  KeyNotDerivableError,
  parseDidPkh,
  publicKeyToDidKey,
  publicKeyToDidPkhSolana,
  resolveDidKey,
  resolveDidPkh,
  resolveDidWeb,
  resolveKeyRefOffline,
  sign,
  signBytes,
  verify,
  verifyBytes,
  verifyManifestProfileA,
} from "./index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.join(HERE, "vectors");

let passCount = 0;
let failCount = 0;
const failures = [];

function report(id, ok, detail) {
  const tag = ok ? "PASS" : "FAIL";
  if (ok) passCount++;
  else {
    failCount++;
    failures.push(id);
  }
  process.stdout.write(`${tag}  [${id}] ${detail}\n`);
}

function check(id, ok, detail, extraOnFail) {
  report(id, ok, detail);
  if (!ok && extraOnFail) process.stdout.write(`      ${extraOnFail}\n`);
}

async function expectThrow(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

async function loadJson(name) {
  return JSON.parse(await fs.readFile(path.join(VECTORS, name), "utf8"));
}

// --------------------------------------------------------------------------
// A — RFC 8785 composite vector (§3.2.2 input -> §3.2.4 exact UTF-8 bytes)
// --------------------------------------------------------------------------
async function sectionA(rfc8785) {
  const { inputJsonText, expectedUtf8Hex } = rfc8785.composite;
  const parsed = JSON.parse(inputJsonText);
  const gotBytes = canonicalize(parsed);
  const gotHex = bytesToHex(gotBytes);
  check(
    "A1",
    gotHex === expectedUtf8Hex,
    `RFC 8785 SS3.2.4 composite: canonical UTF-8 bytes match byte-for-byte (${gotBytes.length} bytes)`,
    `expected ${expectedUtf8Hex}\n      got      ${gotHex}`
  );
  if (gotHex === expectedUtf8Hex) {
    process.stdout.write(`      bytes: ${gotHex}\n`);
  }
  const canonicalString = canonicalizeToString(parsed);
  const roundTripsAsJson = (() => {
    try {
      JSON.parse(canonicalString);
      return true;
    } catch {
      return false;
    }
  })();
  check(
    "A2",
    roundTripsAsJson && bytesToHex(new TextEncoder().encode(canonicalString)) === expectedUtf8Hex,
    "RFC 8785 SS3.2.3 canonical string is valid JSON and equals the SS3.2.4 bytes when UTF-8 encoded"
  );
}

// --------------------------------------------------------------------------
// B — RFC 8785 §3.2.3 property sorting vector
// --------------------------------------------------------------------------
async function sectionB(rfc8785) {
  const { inputJsonText, expectedValueOrder } = rfc8785.sorting;
  const canonicalString = canonicalizeToString(JSON.parse(inputJsonText));
  // JSON.parse preserves textual member order for non-integer-like keys, but we
  // extract the VALUE order independently of that guarantee via regex over the
  // canonical text (values are the only ":"-suffixed strings here).
  const values = [...canonicalString.matchAll(/:"([^"]*)"/g)].map((m) => m[1]);
  const ok = JSON.stringify(values) === JSON.stringify(expectedValueOrder);
  check(
    "B1",
    ok,
    "RFC 8785 SS3.2.3 sorting: 7 exotic keys sort by UTF-16 code units (expected argument order)",
    `expected ${JSON.stringify(expectedValueOrder)}\n      got      ${JSON.stringify(values)}`
  );
  if (ok) process.stdout.write(`      canonical: ${canonicalString}\n`);
}

// --------------------------------------------------------------------------
// C — RFC 8785 Appendix B number serialization (bit-pattern-exact inputs)
// --------------------------------------------------------------------------
async function sectionC(rfc8785) {
  const rows = rfc8785.numbersAppendixB.rows;
  let idx = 0;
  for (const row of rows) {
    idx++;
    const id = `C${idx}`;
    const value = float64FromHex(row.ieee754Hex);
    if (row.expected === "error") {
      const err = await expectThrow(() => canonicalizeToString(value));
      check(id, err !== null, `Appendix B ${row.ieee754Hex} (${row.comment}) -> MUST throw: ${err ? "threw" : "DID NOT THROW"}`);
    } else {
      let got;
      let threw = null;
      try {
        got = canonicalizeToString(value);
      } catch (e) {
        threw = e;
      }
      check(
        id,
        threw === null && got === row.expected,
        `Appendix B ${row.ieee754Hex} -> ${row.expected}${row.comment ? ` (${row.comment})` : ""}`,
        threw ? `threw ${threw.message}` : `got ${got}`
      );
    }
  }
}

function float64FromHex(hex16) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt(`0x${hex16}`), false);
  return dv.getFloat64(0, false);
}

// --------------------------------------------------------------------------
// D — RFC 8785 §3.2.2.2 string rules + lone-surrogate MUST-error
// --------------------------------------------------------------------------
async function sectionD(rfc8785) {
  let idx = 0;
  for (const c of rfc8785.stringRules.cases) {
    idx++;
    const got = canonicalizeToString(c.input);
    check(`D${idx}`, got === c.expected, `SS3.2.2.2 ${c.note}: ${JSON.stringify(c.expected)}`, `got ${JSON.stringify(got)}`);
  }
  const loneHigh = String.fromCharCode(0xd800);
  const loneLow = String.fromCharCode(0xdc00);
  const highThenAscii = String.fromCharCode(0xd83d) + "x";
  for (const [name, s] of [
    ["lone high surrogate U+D800", loneHigh],
    ["lone low surrogate U+DC00", loneLow],
    ["high surrogate followed by non-low", highThenAscii],
  ]) {
    idx++;
    const err = await expectThrow(() => canonicalizeToString(s));
    check(`D${idx}`, err !== null, `SS3.2.2.2 ${name} MUST error: ${err ? "threw" : "DID NOT THROW"}`);
  }
  idx++;
  const err = await expectThrow(() => canonicalizeToString({ [loneHigh]: 1 }));
  check(`D${idx}`, err !== null, `SS3.2.2.2 lone surrogate in PROPERTY NAME must error: ${err ? "threw" : "DID NOT THROW"}`);
}

// --------------------------------------------------------------------------
// E — RFC 8032 §7.1 Ed25519 (external authority for the platform crypto path)
// --------------------------------------------------------------------------
async function sectionE(rfc8032) {
  let idx = 0;
  for (const v of rfc8032.vectors) {
    const seed = hexToBytes(v.secretKeyHex);
    const pub = hexToBytes(v.publicKeyHex);
    const msg = hexToBytes(v.messageHex);
    const sig = hexToBytes(v.signatureHex);

    idx++;
    const derived = await derivePublicKeyRaw(seed);
    check(`E${idx}`, bytesToHex(derived) === v.publicKeyHex, `RFC 8032 ${v.name}: public key derived from secret key matches`, `got ${bytesToHex(derived)}`);

    idx++;
    const verified = await verifyBytes(msg, sig, pub);
    check(`E${idx}`, verified === true, `RFC 8032 ${v.name}: published signature verifies`);

    idx++;
    const ourSig = await signBytes(msg, seed);
    check(
      `E${idx}`,
      bytesToHex(ourSig) === v.signatureHex,
      `RFC 8032 ${v.name}: OUR signature is byte-identical (Ed25519 is deterministic)`,
      `got ${bytesToHex(ourSig)}`
    );

    idx++;
    const flipped = sig.slice();
    flipped[0] ^= 0x01;
    const tampered = await verifyBytes(msg, flipped, pub);
    check(`E${idx}`, tampered === false, `RFC 8032 ${v.name}: bit-flipped signature rejected`);
  }
}

// --------------------------------------------------------------------------
// F — did:key (offline derivation/resolution; spec-example round trip)
// --------------------------------------------------------------------------
async function sectionF(didVectors, rfc8032) {
  const pub = hexToBytes(rfc8032.vectors[0].publicKeyHex);

  const did = publicKeyToDidKey(pub);
  check("F1", /^did:key:z6Mk/.test(did), `did:key from RFC 8032 TEST 1 key starts did:key:z6Mk (multicodec 0xed01): ${did}`);

  const resolved = resolveDidKey(did);
  check("F2", bytesToHex(resolved.rawPublicKey) === rfc8032.vectors[0].publicKeyHex, "did:key round-trip recovers the exact key bytes");

  const specDid = didVectors.didKeySpecExample.did;
  const specResolved = resolveDidKey(specDid);
  const reEncoded = publicKeyToDidKey(specResolved.rawPublicKey);
  check("F3", reEncoded === specDid, `did:key spec example decodes (0xed01 + 32 bytes) and re-encodes identically: ${specDid}`);
  check(
    "F4",
    specResolved.verificationMethodId === didVectors.didKeySpecExample.verificationMethodId,
    "did:key spec example verification method id matches the spec verbatim"
  );

  const err = await expectThrow(() => resolveDidKey(`${did}#zWRONGFRAGMENT`));
  check("F5", err !== null, "did:key with a mismatching fragment is rejected");

  const sigObj = await sign({ hello: "world" }, hexToBytes(rfc8032.vectors[0].secretKeyHex));
  const ok = await verify({ hello: "world" }, sigObj.signature, did);
  check("F6", ok === true, "sign -> verify with the did:key DID string as the verification input");
}

// --------------------------------------------------------------------------
// G — did:web (URL rule offline; resolution ONLY via injected loader)
// --------------------------------------------------------------------------
async function sectionG(didVectors, rfc8032) {
  let idx = 0;
  for (const c of didVectors.didWebUrlRule.cases) {
    idx++;
    const got = didWebToUrl(c.did);
    check(`G${idx}`, got === c.url, `did:web URL rule: ${c.did} -> ${c.url}`, `got ${got}`);
  }

  const pubHex = rfc8032.vectors[0].publicKeyHex;
  const pub = hexToBytes(pubHex);
  const multibase = `z${base58btcEncode(concatBytes(Uint8Array.from([0xed, 0x01]), pub))}`;
  const didDoc = {
    id: "did:web:demo.example",
    verificationMethod: [
      { id: "did:web:demo.example#key-1", type: "Multikey", controller: "did:web:demo.example", publicKeyMultibase: multibase },
    ],
  };
  const loader = async (url) => (url === "https://demo.example/.well-known/did.json" ? didDoc : null);

  idx++;
  const resolved = await resolveDidWeb("did:web:demo.example#key-1", { documentLoader: loader });
  check(`G${idx}`, bytesToHex(resolved.rawPublicKey) === pubHex, "did:web with INJECTED loader extracts the Ed25519 key (publicKeyMultibase)");

  idx++;
  const err = await expectThrow(() => resolveDidWeb("did:web:demo.example"));
  check(
    `G${idx}`,
    err !== null && /out of scope/.test(err.message),
    "did:web WITHOUT a loader refuses (live DID resolution is out of scope - suite posture)"
  );

  idx++;
  const unresolved = await resolveKeyRefOffline("did:web:demo.example#key-1");
  check(`G${idx}`, unresolved.resolution === "unresolved", "keyRef ladder records loaderless did:web as keyRefResolution:'unresolved'");
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// --------------------------------------------------------------------------
// H — did:pkh (solana derivable; other namespaces honestly non-derivable)
// --------------------------------------------------------------------------
async function sectionH(didVectors, rfc8032) {
  const pubHex = rfc8032.vectors[0].publicKeyHex;
  const pub = hexToBytes(pubHex);

  const did = publicKeyToDidPkhSolana(pub, "TESTNETREF11111111111111111111");
  const resolved = resolveDidPkh(did);
  check("H1", bytesToHex(resolved.rawPublicKey) === pubHex, `did:pkh:solana address round-trips the Ed25519 key: ${did}`);

  const sigObj = await sign({ n: 1 }, hexToBytes(rfc8032.vectors[0].secretKeyHex));
  const ok = await verify({ n: 1 }, sigObj.signature, did);
  check("H2", ok === true, "sign -> verify with the did:pkh:solana DID as the verification input");

  let idx = 2;
  for (const bad of didVectors.didPkh.nonDerivable) {
    idx++;
    const parsedOk = (() => {
      try {
        parseDidPkh(bad);
        return true;
      } catch {
        return false;
      }
    })();
    const err = await expectThrow(() => resolveDidPkh(bad));
    check(
      `H${idx}`,
      parsedOk && err instanceof KeyNotDerivableError,
      `did:pkh non-solana parses but key derivation honestly refuses (${bad.split(":")[2]}): KeyNotDerivableError`
    );
  }

  idx++;
  const ladder = await resolveKeyRefOffline(didVectors.didPkh.nonDerivable[0]);
  check(`H${idx}`, ladder.resolution === "unresolved", "keyRef ladder records non-derivable did:pkh as 'unresolved'");
}

// --------------------------------------------------------------------------
// I — UM Signature Profile A (shape, frozen bytes, tamper, 1.6.4, interop-in)
// --------------------------------------------------------------------------
async function sectionI(profileVector) {
  const seed = hexToBytes(profileVector.signingSeedHex);
  const manifest = profileVector.unsignedManifest;

  // I1 — canonical signing input matches the frozen vector string.
  const inputString = computeSigningInputString(manifest);
  check(
    "I1",
    inputString === profileVector.expectedSigningInput,
    `Profile A signing input (JCS of manifest-without-signature) matches frozen vector (${inputString.length} chars)`,
    `expected ${profileVector.expectedSigningInput}\n      got      ${inputString}`
  );

  // I2 — sign() reproduces the frozen signature bytes (deterministic Ed25519).
  const { signature, protected: prot } = await sign(manifest, seed, {
    created: profileVector.created,
  });
  check("I2", signature === profileVector.expectedSignatureB64u, "sign() reproduces the frozen base64url signature byte-for-byte", `got ${signature}`);

  // I3 — protected block shape (Profile A member-by-member).
  const shapeOk =
    prot.algorithm === "Ed25519" &&
    prot.canonicalization === "JCS-RFC8785" &&
    typeof prot.keyRef === "string" &&
    prot.keyRef.startsWith("did:key:z6Mk") &&
    prot.keyRef.includes("#z6Mk") &&
    prot.publicKeySpkiB64 === profileVector.expectedPublicKeySpkiB64 &&
    prot.created === profileVector.created &&
    /^[A-Za-z0-9_-]{86}$/.test(signature);
  check(
    "I3",
    shapeOk,
    "protected block: algorithm/canonicalization/keyRef(did:key URL)/publicKeySpkiB64(base64 SPKI)/created; value is 86-char unpadded base64url",
    JSON.stringify(prot)
  );

  // I4 — attach + verify round-trip (embedded key, did:key keyRef consistency).
  const signed = await attachSignatureProfileA(manifest, seed, { created: profileVector.created });
  const detail = await verifyManifestProfileA(signed);
  check(
    "I4",
    detail.ok === true && detail.checks.keyRefConsistency === "consistent" && detail.checks.keyRefResolution === "resolved",
    `signed manifest verifies; did:key keyRef vs embedded SPKI consistency = '${detail.checks.keyRefConsistency}' (Section 1.6.4 check ran)`
  );

  // I5 — tamper with a signed FIELD -> reject.
  const tamperedSubject = { ...signed, subject: "did:example:mallory" };
  const t1 = await verifyManifestProfileA(tamperedSubject);
  check("I5", t1.ok === false, `subject mutated after signing -> rejected (${t1.reason})`);

  // I6 — tamper with the SIGNATURE bits -> reject.
  const brokenSig = { ...signed, signature: { ...signed.signature, value: flipBase64UrlBit(signed.signature.value) } };
  const t2 = await verifyManifestProfileA(brokenSig);
  check("I6", t2.ok === false, `signature.value bit-flipped -> rejected (${t2.reason})`);

  // I7 — KEY SUBSTITUTION: keyRef swapped to a different did:key -> 1.6.4 catches.
  const otherDid = publicKeyToDidKey(hexToBytes(profileVector.substitutionPublicKeyHex));
  const substituted = { ...signed, signature: { ...signed.signature, keyRef: `${otherDid}#${otherDid.slice("did:key:".length)}` } };
  const t3 = await verifyManifestProfileA(substituted);
  check(
    "I7",
    t3.ok === false && t3.reason === "keyref-embedded-key-mismatch",
    "keyRef substituted for a different did:key -> rejected by the keyRef<->embedded-key consistency check (1.6.4)"
  );

  // I8 — unsupported profile pair MUST NOT be reinterpreted (SS5.1).
  const es256 = { ...signed, signature: { ...signed.signature, algorithm: "ES256" } };
  const t4 = await verifyManifestProfileA(es256);
  check("I8", t4.ok === false && t4.reason === "unsupported-profile", "algorithm 'ES256' -> unsupported-profile (never reinterpreted as baseline)");

  // I9 — unresolvable keyRef + NO embedded key -> cannot verify -> reject.
  const noEmbed = { ...signed, signature: { ...signed.signature } };
  delete noEmbed.signature.publicKeySpkiB64;
  noEmbed.signature.keyRef = "did:example:alice#key-1";
  const t5 = await verifyManifestProfileA(noEmbed);
  check(
    "I9",
    t5.ok === false && t5.reason === "keyref-unresolvable-and-no-embedded-key",
    "unresolvable keyRef with no embedded key -> reject (mirrors invalid/signature-keyref-without-embedded-key)"
  );

  // I10 — the UM suite's OWN reference-signed fixture verifies under THIS library.
  const umFixture = JSON.parse(await fs.readFile(path.join(VECTORS, "um-minimal-signed-manifest.fixture.jsonld"), "utf8"));
  const umDetail = await verifyManifestProfileA(umFixture);
  check(
    "I10",
    umDetail.ok === true && umDetail.checks.keyRefResolution === "unresolved",
    "UM conformance fixture minimal-signed-manifest.jsonld (their key+signature) VERIFIES; did:example keyRef recorded 'unresolved' (suite posture)"
  );

  // I11 — same UM fixture, subject mutated -> reject (their key, tampered bytes).
  const umTampered = { ...umFixture, subject: "did:example:mallory" };
  const umT = await verifyManifestProfileA(umTampered);
  check("I11", umT.ok === false, `UM fixture with mutated subject -> rejected (${umT.reason})`);

  // I12 — v0.4 signing-input rule: presentationProof is EXCLUDED from the input.
  const v04 = { ...manifest, manifestVersion: "0.4", presentationProof: { "@type": "um:PresentationProof", proofValue: "xxxx" } };
  const v04Base = { ...manifest, manifestVersion: "0.4" };
  const sameInput = computeSigningInputString(v04) === computeSigningInputString(v04Base);
  const v04Signed = await attachSignatureProfileA(v04, seed, { created: profileVector.created });
  const v04Detail = await verifyManifestProfileA(v04Signed);
  check("I12", sameInput && v04Detail.ok === true, "v0.4 rule (Base 1.6.3): presentationProof excluded from signing input; signed v0.4 object verifies with validation attached");
}

function flipBase64UrlBit(b64u) {
  // Flip one bit in the first byte by swapping the first character deterministically.
  const first = b64u[0];
  const replacement = first === "A" ? "B" : "A";
  return replacement + b64u.slice(1);
}

// --------------------------------------------------------------------------
// K — regression: v0.4 presentationProof signing-input EXCLUSION
// (Base 1.6.3). The UM suite's OWN signed fixture
// valid/manifest-with-presentation-proof.jsonld (verbatim copy in vectors/)
// verifies ONLY when presentationProof is excluded from the signing input;
// an implementation that fails to exclude it MUST fail. Added —
// ADDITIVE ONLY (no existing vector touched).
// --------------------------------------------------------------------------
async function sectionK() {
  const fixture = JSON.parse(
    await fs.readFile(path.join(VECTORS, "um-v04-manifest-with-presentation-proof.fixture.jsonld"), "utf8")
  );

  // K1 — with the v0.4 exclusion set (auto-applied for manifestVersion 0.4),
  // the UM reference-signed fixture verifies under THIS library.
  const withExclusion = await verifyManifestProfileA(fixture);
  check(
    "K1",
    withExclusion.ok === true && withExclusion.checks.keyRefResolution === "unresolved",
    "UM v0.4 fixture manifest-with-presentation-validation VERIFIES with presentationProof excluded (Base 1.6.3); did:example keyRef 'unresolved' (suite posture)"
  );

  // K2 — an implementation that FAILS to exclude presentationProof (only
  // `signature` removed — the v0.2/v0.3 rule) MUST fail verification.
  const withoutExclusion = await verifyManifestProfileA(fixture, { exclude: [] });
  check(
    "K2",
    withoutExclusion.ok === false,
    "same fixture with presentationProof NOT excluded from the signing input FAILS verification (the runtime regression: non-excluding implementations must fail)"
  );

  // K3 — the exclusion is load-bearing: the two signing inputs differ.
  const excluded = computeSigningInputString(fixture);
  const included = computeSigningInputString(fixture, { exclude: [] });
  check(
    "K3",
    excluded !== included && !excluded.includes("presentationProof") && included.includes("presentationProof"),
    "signing input WITHOUT the exclusion still contains presentationProof; the excluded form does not (byte-level difference proven)"
  );
}

// --------------------------------------------------------------------------
// J — determinism / canonical idempotence
// --------------------------------------------------------------------------
async function sectionJ() {
  const a = { z: [1, { b: 2, a: 3 }], a: "x", m: { "2": 1, "10": 2, "1": 3 } };
  const b = { m: { "1": 3, "10": 2, "2": 1 }, a: "x", z: [1, { a: 3, b: 2 }] };
  const ca = canonicalizeToString(a);
  const cb = canonicalizeToString(b);
  check("J1", ca === cb, `key-insertion order never changes the bytes: ${ca}`);

  const again = canonicalizeToString(JSON.parse(ca));
  check("J2", again === ca, "canonicalization is idempotent (canon(parse(canon(x))) == canon(x))");

  const arr = canonicalizeToString([0.000001, 1e21, -0]);
  check("J3", arr === "[0.000001,1e+21,0]", `array order preserved; numbers normalized: ${arr}`);
}

// --------------------------------------------------------------------------
async function main() {
  process.stdout.write("runtime signing library - test vectors\n");
  process.stdout.write("======================================\n");

  const [rfc8785, rfc8032, didVectors, profileVector] = await Promise.all([
    loadJson("rfc8785.json"),
    loadJson("rfc8032-ed25519.json"),
    loadJson("did-vectors.json"),
    loadJson("um-profile-a.json"),
  ]);

  process.stdout.write(`\n-- A: RFC 8785 composite (${rfc8785.composite.citation})\n`);
  await sectionA(rfc8785);
  process.stdout.write(`\n-- B: RFC 8785 sorting (${rfc8785.sorting.citation})\n`);
  await sectionB(rfc8785);
  process.stdout.write(`\n-- C: RFC 8785 numbers (${rfc8785.numbersAppendixB.citation})\n`);
  await sectionC(rfc8785);
  process.stdout.write(`\n-- D: RFC 8785 string rules (${rfc8785.stringRules.citation})\n`);
  await sectionD(rfc8785);
  process.stdout.write(`\n-- E: Ed25519 (${rfc8032.source})\n`);
  await sectionE(rfc8032);
  process.stdout.write("\n-- F: did:key\n");
  await sectionF(didVectors, rfc8032);
  process.stdout.write("\n-- G: did:web (URL rule + injected loader only)\n");
  await sectionG(didVectors, rfc8032);
  process.stdout.write("\n-- H: did:pkh (solana derivable; others refuse honestly)\n");
  await sectionH(didVectors, rfc8032);
  process.stdout.write("\n-- I: UM Signature Profile A\n");
  await sectionI(profileVector);
  process.stdout.write("\n-- J: determinism\n");
  await sectionJ();
  process.stdout.write("\n-- K: runtime regression — v0.4 presentationProof signing-input exclusion\n");
  await sectionK();

  process.stdout.write("\n======================================\n");
  process.stdout.write(`TOTAL: ${passCount + failCount}  PASS: ${passCount}  FAIL: ${failCount}\n`);
  if (failCount > 0) {
    process.stdout.write(`FAILED VECTORS: ${failures.join(", ")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("ALL VECTORS PASS\n");
  }
}

main().catch((e) => {
  process.stdout.write(`RUNNER ERROR: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});
