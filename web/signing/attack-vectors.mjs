#!/usr/bin/env node
// ADVERSARIAL ATTACK VECTORS against the signing keystone.
//
// This file is ADDITIVE and DISJOINT: it imports the module under test (web/signing/)
// read-only and TRIES TO BREAK IT. It does not modify the keystone. Run:
//
//   node web/signing/attack-vectors.mjs
//
// Each attack prints one of:
//   RESISTED   — the keystone correctly rejected / handled the attack (a PASS).
//   EXPECTED   — a correct BY-DESIGN behavior the attack tried to mislabel as a bug
//                (e.g. mutating a spec-EXCLUDED field still verifies) — also a PASS.
//   ⚠️ VULNERABLE — a REAL break: a canonicalization collision the library is
//                responsible for, an undetected tamper, a check that should fail
//                closed but doesn't, or key/alg confusion. Fails the run (exit 1).
//   BOUNDARY   — an HONEST hardening gap that is NOT a crypto break in the library
//                but is a real system-level risk delegated to input discipline
//                (I-JSON numeric range, duplicate keys). Reported, does NOT fail the
//                run — tracked for a follow-up hardening task.
//
// HONESTY BOUNDARY (from the task): a feature that is intentionally fail-closed /
// PREVIEW (postQuantumSignature not implemented, did:web out of scope) failing to
// verify is CORRECT, not a vulnerability. Only (a) canonicalization collisions,
// (b) undetected tampers, (c) bypass of a check that SHOULD fail closed, and
// (d) key/alg confusion are reported as ⚠️ VULNERABLE.

import {
  // canonicalization
  canonicalize, // jcsCanonicalizeToBytes -> Uint8Array
  canonicalizeToString, // jcsCanonicalize -> string
  computeSigningInput,
  // profile A
  attachSignatureProfileA,
  verify,
  verifyManifestProfileA,
  // ed25519 + keys
  generateKeyPair,
  rawPublicKeyToSpki,
  spkiToRawPublicKey,
  verifyBytes,
  importPublicKey,
  // did
  publicKeyToDidKey,
  // codecs
  bytesToBase64,
  bytesToHex,
  base64ToBytes,
} from "./index.mjs";

// --------------------------------------------------------------------------
// Tiny result harness.
// --------------------------------------------------------------------------
let PASS = 0;
let VULN = 0;
let BOUND = 0;
const findings = []; // { kind, name, detail }

const banner = (t) => console.log(`\n=== ${t} ===`);
const resisted = (name, detail) => { PASS++; console.log(`  RESISTED   ${name}${detail ? " — " + detail : ""}`); };
const expected = (name, detail) => { PASS++; console.log(`  EXPECTED   ${name}${detail ? " — " + detail : ""}`); };
const vulnerable = (name, detail) => { VULN++; findings.push({ kind: "VULNERABLE", name, detail }); console.log(`  ⚠️ VULNERABLE ${name} — ${detail}`); };
const boundary = (name, detail) => { BOUND++; findings.push({ kind: "BOUNDARY", name, detail }); console.log(`  BOUNDARY   ${name} — ${detail}`); };

const clone = (o) => JSON.parse(JSON.stringify(o));
const hex = (u8) => bytesToHex(u8);

function baseManifest(extra = {}) {
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2", "https://universalmanifest.net/ns/v0.4"],
    "@type": ["um:Manifest"],
    "@id": "urn:uuid:11111111-1111-4111-8111-111111111111",
    manifestVersion: "0.4",
    subject: "did:example:subject",
    issuedAt: "2026-07-05T00:00:00.000Z",
    expiresAt: "2026-07-05T01:00:00.000Z",
    ...extra,
  };
}

// Verify helper that NEVER throws (a thrown verify is fail-closed only if the
// caller treats it as failure — we normalize both to { ok:false }).
async function safeVerify(manifest, opts) {
  try {
    return await verifyManifestProfileA(manifest, opts);
  } catch (e) {
    return { ok: false, reason: `threw:${(e && e.message) || e}`, checks: {}, threw: true };
  }
}

async function main() {
  console.log("################################################################");
  console.log("# runtime SIGNING KEYSTONE — ADVERSARIAL ATTACK VECTORS         #");
  console.log("# target: web/signing/ (JCS-RFC8785 + Ed25519 Profile A)       #");
  console.log("################################################################");

  const A = await generateKeyPair(); // the legitimate issuer key
  const B = await generateKeyPair(); // the attacker / substitution key
  const Apriv = A.privateKey;
  const Bpriv = B.privateKey;
  const ADidKey = publicKeyToDidKey(A.rawPublicKey);
  const BDidKey = publicKeyToDidKey(B.rawPublicKey);
  const ADidKeyUrl = `${ADidKey}#${ADidKey.slice("did:key:".length)}`;

  // A reference legitimately-signed v0.4 manifest (keyRef = A's did:key, embeds A's SPKI).
  const signed = await attachSignatureProfileA(baseManifest(), Apriv);
  {
    const r = await safeVerify(signed);
    if (r.ok && r.checks.keyRefConsistency === "consistent") {
      console.log(`\n[setup] reference manifest verifies (keyRefConsistency=${r.checks.keyRefConsistency})`);
    } else {
      console.error("[setup] reference manifest did not verify — cannot run attacks", JSON.stringify(r));
      process.exit(2);
    }
  }

  // ======================================================================
  banner("GROUP 1 — Canonicalization collisions & ambiguities");
  // ======================================================================

  // 1.1 Key ordering: reordering object keys MUST NOT change canonical bytes
  //     (that is the whole point — one signature is stable under key order).
  {
    const a = hex(canonicalize({ b: 1, a: 2, c: 3 }));
    const b = hex(canonicalize({ c: 3, a: 2, b: 1 }));
    if (a === b) expected("key-reordering yields identical canonical bytes", "a signature is stable under key order (intended)");
    else vulnerable("key-reordering", `canonical bytes differ across key order: ${a} vs ${b}`);
  }

  // 1.2 Nested key sorting is recursive.
  {
    const a = hex(canonicalize({ x: { z: 1, a: 2 }, m: [{ q: 1, b: 2 }] }));
    const b = hex(canonicalize({ m: [{ b: 2, q: 1 }], x: { a: 2, z: 1 } }));
    if (a === b) expected("nested key sorting is recursive & order-independent", "");
    else vulnerable("nested-key-sort", `nested reorder changed bytes: ${a} vs ${b}`);
  }

  // 1.3 Array element order is PRESERVED (arrays must NOT be sorted) — otherwise
  //     [1,2] and [2,1] would collide (a real collision of distinct documents).
  {
    const a = hex(canonicalize({ arr: [1, 2, 3] }));
    const b = hex(canonicalize({ arr: [3, 2, 1] }));
    if (a !== b) {
      resisted("array reordering produces DIFFERENT canonical bytes", "arrays are order-significant, no collision");
      // and the signature must not cross-verify
      const s = await attachSignatureProfileA(baseManifest({ arr: [1, 2, 3] }), Apriv);
      const t = clone(s); t.arr = [3, 2, 1];
      const r = await safeVerify(t);
      if (!r.ok) resisted("reordered-array tamper rejected", `reason=${r.reason}`);
      else vulnerable("array-reorder tamper", "a signature over [1,2,3] verified [3,2,1]");
    } else {
      vulnerable("array-reorder collision", "arrays are being sorted — [1,2,3] and [3,2,1] share canonical bytes");
    }
  }

  // 1.4 Unicode NFC vs NFD: JCS (RFC 8785) does NOT Unicode-normalize, so "café"
  //     as NFC (U+00E9) and NFD (U+0065 U+0301) are DISTINCT byte strings. The
  //     attack: sign the NFC form, present the NFD form under the same signature.
  {
    const nfc = "café"; // é as one code point
    const nfd = "café"; // e + combining acute
    const ca = hex(canonicalize({ city: nfc }));
    const cb = hex(canonicalize({ city: nfd }));
    if (ca !== cb) resisted("NFC vs NFD canonicalize to DIFFERENT bytes", "JCS does not normalize; no collision");
    else vulnerable("unicode-normalization collision", "NFC and NFD forms share canonical bytes");

    const s = await attachSignatureProfileA(baseManifest({ city: nfc }), Apriv);
    const t = clone(s); t.city = nfd;
    const r = await safeVerify(t);
    if (!r.ok) resisted("NFC→NFD substitution rejected", `reason=${r.reason}`);
    else vulnerable("unicode NFC→NFD tamper", "signature over NFC 'café' verified the NFD form");
  }

  // 1.5 Number canonicalization: 1 vs 1.0 vs 1e0 vs 1.0e0 are the SAME IEEE-754
  //     value; identical canonical bytes is CORRECT (RFC 8785 §3.2.2.3 / Appendix B).
  {
    const forms = ["1", "1.0", "1e0", "1.0e0", "10e-1"];
    const canon = forms.map((t) => hex(canonicalize({ n: JSON.parse(t) })));
    const allSame = canon.every((c) => c === canon[0]);
    if (allSame && canonicalizeToString({ n: 1 }) === '{"n":1}')
      expected("1 / 1.0 / 1e0 / 10e-1 canonicalize identically to \"1\"", "same number, one canonical form (intended)");
    else vulnerable("number-form canonicalization", `forms diverged: ${canon.join(", ")}`);
  }

  // 1.6 Negative zero: JSON has no -0; -0 must serialize as "0".
  {
    const a = canonicalizeToString({ n: -0 });
    const b = canonicalizeToString({ n: 0 });
    if (a === '{"n":0}' && b === '{"n":0}') expected("-0 serializes as 0 (JSON has no negative zero)", "");
    else vulnerable("-0 handling", `-0 => ${a}, 0 => ${b}`);
  }

  // 1.7 *** LARGE-INTEGER PRECISION-LOSS COLLISION ***
  //     Two DISTINCT JSON documents whose only difference is an integer beyond
  //     2^53 collapse to the SAME IEEE-754 double at JSON.parse time, hence the
  //     SAME canonical bytes -> ONE signature verifies BOTH documents.
  {
    const textA = '{"@id":"x","manifestVersion":"0.4","n":9007199254740992}'; // 2^53
    const textB = '{"@id":"x","manifestVersion":"0.4","n":9007199254740993}'; // 2^53 + 1
    const objA = JSON.parse(textA);
    const objB = JSON.parse(textB);
    const ca = hex(canonicalize(objA));
    const cb = hex(canonicalize(objB));
    const collide = ca === cb;
    if (collide) {
      // Prove a single signature covers both distinct source documents.
      const s = await attachSignatureProfileA(baseManifest({ n: objA.n }), Apriv);
      const t = clone(s); // t.n is objA.n's double (== objB.n's double)
      const r = await safeVerify(t);
      boundary(
        "large-integer (>2^53) canonical collision",
        `distinct JSON texts ${textA} and ${textB} both canonicalize to ${ca}; JSON.parse rounds 2^53+1 -> 2^53. ` +
        `This is an I-JSON range violation manufactured by JSON.parse, NOT a JCS bug (RFC 8785 §3.1 assumes I-JSON input). ` +
        `The library does NOT enforce the safe-integer range, so signing untrusted big-integer JSON is collision-prone. ` +
        `FIX (follow-up): reject numbers outside ±(2^53-1) or require them string-encoded before signing (lib header already advises strings). one-sig-verifies-both=${r.ok}`
      );
    } else {
      resisted("large-integer canonicalization", `2^53 and 2^53+1 produced different bytes: ${ca} vs ${cb}`);
    }
  }

  // 1.8 Duplicate object keys: RFC 8785 §3.1 delegates I-JSON duplicate-key
  //     rejection to the PARSER; JSON.parse keeps the LAST. Two distinct texts
  //     -> one parsed value -> one signature.
  {
    const textA = '{"a":1,"a":2}';
    const textB = '{"a":2}';
    const ca = hex(canonicalize(JSON.parse(textA)));
    const cb = hex(canonicalize(JSON.parse(textB)));
    if (ca === cb) {
      boundary(
        "duplicate-key parse collision",
        `${textA} and ${textB} both parse to {a:2} and share canonical bytes ${ca}. ` +
        `RFC 8785 §3.1 delegates duplicate-key rejection to the parser (I-JSON / RFC 7493); JSON.parse keeps last. ` +
        `FIX (follow-up): reject duplicate keys with an I-JSON-strict parse before signing untrusted input.`
      );
    } else {
      resisted("duplicate-key canonicalization", "");
    }
  }

  // 1.9 __proto__ as an OWN property must be SIGNED (included), never silently
  //     dropped (a drop = a field present in the doc but outside the signature).
  {
    const parsed = JSON.parse('{"__proto__":{"x":1},"a":2}');
    const str = canonicalizeToString(parsed);
    const includesProto = str.includes('"__proto__"');
    const noPollution = ({}).x === undefined && Object.getPrototypeOf({}).x === undefined;
    // computeSigningInput must also preserve it through its {...manifest} spread.
    const si = new TextDecoder().decode(computeSigningInput({ ...baseManifest(), ...parsed }));
    const siHasProto = si.includes('"__proto__"');
    if (includesProto && noPollution && siHasProto)
      resisted("__proto__ own-property is canonicalized (signed), no prototype pollution", "");
    else if (!includesProto || !siHasProto)
      vulnerable("__proto__ smuggling", `__proto__ dropped from signing input (canon=${includesProto}, signingInput=${siHasProto}) — a field could ride unsigned`);
    else
      vulnerable("prototype pollution via canonicalization", "Object.prototype was polluted");
  }

  // 1.10 Whitespace / insignificant formatting cannot matter (we canonicalize
  //      parsed values, not text) — quick guard that pretty vs compact agree.
  {
    const a = hex(canonicalize(JSON.parse('{ "a" : 1 , "b" : [ 2 , 3 ] }')));
    const b = hex(canonicalize(JSON.parse('{"a":1,"b":[2,3]}')));
    if (a === b) expected("insignificant whitespace does not affect canonical bytes", "");
    else vulnerable("whitespace sensitivity", `${a} vs ${b}`);
  }

  // ======================================================================
  banner("GROUP 2 — Signing-input exclusion abuse");
  // ======================================================================

  // 2.1 Mutating an EXCLUDED field after signing STILL verifies — CORRECT for
  //     v0.4 {signature, presentationProof, postQuantumSignature} (they are added
  //     post-signing by design). Demonstrate + flag the downstream-trust caveat.
  {
    const m = baseManifest({
      presentationProof: { proofType: "did-auth", challenge: "orig", audience: "aud", created: "2026-07-05T00:00:00Z", proofValue: "PV" },
    });
    const s = await attachSignatureProfileA(m, Apriv);
    const t = clone(s); t.presentationProof.challenge = "ATTACKER-CONTROLLED";
    const r = await safeVerify(t);
    if (r.ok) expected("mutating presentationProof after signing still verifies", "presentationProof is spec-excluded from the signing input (Base 1.6.3) — crypto-correct; consumer MUST re-validate it independently, never trust it as signed");
    else vulnerable("presentationProof exclusion", `excluded field mutation broke verification (reason=${r.reason}) — exclusion set wrong`);

    const t2 = clone(s); delete t2.presentationProof;
    const r2 = await safeVerify(t2);
    if (r2.ok) expected("removing presentationProof after signing still verifies", "excluded field is not part of signed bytes");
    else vulnerable("presentationProof removal", `removing excluded field broke verification (reason=${r2.reason})`);

    const t3 = clone(s); t3.postQuantumSignature = { algorithm: "ML-DSA-65", value: "ATTACKER" };
    const r3 = await safeVerify(t3);
    if (r3.ok) expected("adding postQuantumSignature after signing still verifies", "postQuantumSignature is spec-excluded (PREVIEW/unimplemented) — MUST NOT be trusted as signed by the consumer");
    else vulnerable("postQuantumSignature exclusion", `reason=${r3.reason}`);
  }

  // 2.2 Adding an UNKNOWN top-level field after signing MUST break verification
  //     (v0.4 CONFORMANCE §2 item 17 + fixture manifest-with-unknown-members:
  //     unknown members MUST NOT be stripped before verification).
  {
    const t = clone(signed); t.unknownRootMember = { injected: "by-attacker" };
    const r = await safeVerify(t);
    if (!r.ok) resisted("unknown top-level field added after signing is REJECTED", `reason=${r.reason} (unknown members are signed, per §2.17)`);
    else vulnerable("unknown-member injection", "an unknown top-level field added after signing still verified — unknown members are being stripped before verification");
  }

  // 2.3 Only the TOP-LEVEL `signature` is excluded — a nested field NAMED
  //     "signature" (inside a facet) is SIGNED and its mutation must be caught.
  {
    const m = baseManifest({ facet: { "@id": "urn:f", signature: "inner-value" } });
    const s = await attachSignatureProfileA(m, Apriv);
    const t = clone(s); t.facet.signature = "inner-TAMPERED";
    const r = await safeVerify(t);
    if (!r.ok) resisted("nested (non-top-level) 'signature' field is signed & tamper-detected", `reason=${r.reason}`);
    else vulnerable("nested-signature exclusion over-reach", "a nested field named 'signature' was excluded from signing — mutation not detected");
  }

  // 2.4 manifestVersion type confusion changes the exclusion set. The library
  //     gates the presentationProof/postQuantumSignature exclusion on strict
  //     `manifestVersion === "0.4"` (a string). A NON-string version silently
  //     turns exclusion OFF (pp becomes signed). This is self-consistent for the
  //     library's own sign+verify, but diverges from a spec verifier (which
  //     excludes pp for v0.4) and from the emitter (which strips unconditionally).
  {
    const m = { ...baseManifest(), manifestVersion: 0.4, presentationProof: { proofType: "did-auth", challenge: "c" } };
    const s = await attachSignatureProfileA(m, Apriv); // pp INCLUDED (0.4 is a number, not "0.4")
    const rOk = await safeVerify(s); // self-consistent -> verifies
    const t = clone(s); t.presentationProof.challenge = "MUTATED";
    const rTamp = await safeVerify(t); // pp now signed -> mutation breaks it
    if (rOk.ok && !rTamp.ok) {
      boundary(
        "manifestVersion exclusion-gate type confusion",
        `exclusion of presentationProof/postQuantumSignature is gated on strict manifestVersion === "0.4"; a numeric/malformed manifestVersion silently DISABLES the exclusion so presentationProof becomes part of the signed bytes. ` +
        `Self-consistent for this library, but a spec verifier (excludes pp for v0.4) and the emitter (stripForSigning strips unconditionally) would compute DIFFERENT bytes -> interop/verify divergence. ` +
        `FIX (follow-up): apply the exclusion off a validated version or unconditionally, and reject non-string manifestVersion before signing.`
      );
    } else {
      resisted("manifestVersion type confusion", `rOk=${rOk.ok} rTamp=${rTamp.ok}`);
    }
  }

  // ======================================================================
  banner("GROUP 3 — Tamper detection (must FAIL closed)");
  // ======================================================================

  // 3.1 Flip a byte in a signed, non-excluded field -> MUST fail.
  {
    const t = clone(signed); t.subject = String(t.subject) + "x";
    const r = await safeVerify(t);
    if (!r.ok) resisted("mutated subject (signed field) rejected", `reason=${r.reason}`);
    else vulnerable("subject tamper undetected", "mutating a signed field still verified");
  }

  // 3.2 Bit-flip the signature value -> MUST fail.
  {
    const t = clone(signed); const v = t.signature.value;
    t.signature.value = (v[0] === "A" ? "B" : "A") + v.slice(1);
    const r = await safeVerify(t);
    if (!r.ok) resisted("bit-flipped signature.value rejected", `reason=${r.reason}`);
    else vulnerable("signature bit-flip undetected", "a corrupted signature verified");
  }

  // 3.3 Truncated signature (decodes to <64 bytes) -> MUST fail (not throw-open).
  {
    const t = clone(signed); t.signature.value = t.signature.value.slice(0, 40);
    const r = await safeVerify(t);
    if (!r.ok) resisted("truncated signature rejected", `reason=${r.reason}`);
    else vulnerable("truncated signature accepted", "");
  }

  // 3.4 Oversized signature (decodes to >64 bytes) -> MUST fail.
  {
    const t = clone(signed); t.signature.value = t.signature.value + "AAAAAAAA";
    const r = await safeVerify(t);
    if (!r.ok) resisted("oversized signature rejected", `reason=${r.reason}`);
    else vulnerable("oversized signature accepted", "");
  }

  // 3.5 Empty signature value -> MUST fail with a clean reason.
  {
    const t = clone(signed); t.signature.value = "";
    const r = await safeVerify(t);
    if (!r.ok) resisted("empty signature.value rejected", `reason=${r.reason}`);
    else vulnerable("empty signature accepted", "");
  }

  // 3.6 Garbage / non-base64 signature value -> MUST fail (not throw-open).
  {
    const t = clone(signed); t.signature.value = "!!!! not base64 !!!!";
    const r = await safeVerify(t);
    if (!r.ok) resisted("non-base64 signature.value rejected", `reason=${r.reason}`);
    else vulnerable("garbage signature accepted", "");
  }

  // ======================================================================
  banner("GROUP 4 — Key substitution & algorithm confusion");
  // ======================================================================

  // 4.1 Wrong key: verify A's signature under B's public key -> MUST fail.
  {
    const ok = await verify(signed, signed.signature.value, B.rawPublicKey).catch(() => false);
    if (ok === false) resisted("A's signature under B's public key fails", "");
    else vulnerable("wrong-key verify", "a signature verified under an unrelated public key");
  }

  // 4.2 Embedded-key substitution: swap embedded SPKI to B, keep A's did:key
  //     keyRef and A's signature -> §1.6.4 consistency check MUST reject.
  {
    const t = clone(signed);
    t.signature.publicKeySpkiB64 = bytesToBase64(rawPublicKeyToSpki(B.rawPublicKey));
    const r = await safeVerify(t);
    if (!r.ok) resisted("embedded-key substitution caught by keyRef↔embedded consistency", `reason=${r.reason} keyRefConsistency=${r.checks.keyRefConsistency}`);
    else vulnerable("embedded-key substitution", "embedded key swapped for a foreign key still verified");
  }

  // 4.3 keyRef substitution: point keyRef at B's did:key, keep A's embedded key
  //     and A's signature -> consistency mismatch MUST reject.
  {
    const t = clone(signed);
    t.signature.keyRef = `${BDidKey}#${BDidKey.slice("did:key:".length)}`;
    const r = await safeVerify(t);
    if (!r.ok) resisted("keyRef substitution (did:key B vs embedded A) caught", `reason=${r.reason}`);
    else vulnerable("keyRef substitution", "keyRef pointed at a different key than embedded still verified");
  }

  // 4.4 IMPERSONATION of a did:key identity: attacker signs modified content with
  //     THEIR key B but claims A's identity (keyRef = A's did:key, NO embedded
  //     key so no consistency shortcut). Verifier derives A from the keyRef and
  //     B's signature MUST fail against A.
  {
    const forged = await attachSignatureProfileA(
      baseManifest({ subject: ADidKey }),
      Bpriv,
      { keyRef: ADidKeyUrl, embedPublicKey: false }
    );
    const r = await safeVerify(forged);
    if (!r.ok) resisted("impersonation via A's keyRef + B's signature (no embedded key) rejected", `reason=${r.reason} keySource=${r.checks.keySource}`);
    else vulnerable("did:key impersonation", "a manifest claiming A's did:key keyRef verified under B's signature");
  }

  // 4.5 Algorithm confusion: non-Ed25519 / wrong canonicalization pairs MUST be
  //     rejected as unsupported-profile — NEVER reinterpreted as Profile A (§5.1).
  {
    const cases = [
      ["ES256", "JCS-RFC8785"],
      ["RS256", "JCS-RFC8785"],
      ["none", "JCS-RFC8785"],
      ["Ed25519", "JCS"],
      ["Ed25519", "URDNA2015"],
      ["ed25519", "JCS-RFC8785"], // case confusion
    ];
    let allRejected = true;
    const reasons = [];
    for (const [alg, canon] of cases) {
      const t = clone(signed); t.signature.algorithm = alg; t.signature.canonicalization = canon;
      const r = await safeVerify(t);
      reasons.push(`${alg}/${canon}:${r.reason}`);
      if (r.ok) { allRejected = false; vulnerable("algorithm confusion", `profile pair ${alg}/${canon} was accepted`); }
    }
    if (allRejected) resisted("all non-Profile-A algorithm/canonicalization pairs rejected", reasons.join(" | "));
  }

  // 4.6 Missing profile members -> reject (no defaulting to Profile A).
  {
    const t1 = clone(signed); delete t1.signature.algorithm;
    const t2 = clone(signed); delete t2.signature.canonicalization;
    const r1 = await safeVerify(t1);
    const r2 = await safeVerify(t2);
    if (!r1.ok && !r2.ok) resisted("missing algorithm/canonicalization member rejected", `${r1.reason} / ${r2.reason}`);
    else vulnerable("profile-member defaulting", `missing member accepted (alg-missing ok=${r1.ok}, canon-missing ok=${r2.ok})`);
  }

  // 4.7 Malformed did:key keyRef (with embedded key) MUST NOT verify. It should
  //     fail closed (the lib treats a malformed derivable ref as tamper-evidence).
  {
    const t = clone(signed); t.signature.keyRef = "did:key:zINVALIDBYTESxxxxxxxxxx";
    const r = await safeVerify(t);
    if (!r.ok) resisted("malformed did:key keyRef fails closed", `reason=${r.reason}${r.threw ? " (threw→treated as fail)" : ""}`);
    else vulnerable("malformed keyRef bypass", "a malformed did:key keyRef still verified");
  }

  // 4.8 Cross-curve multicodec confusion: a did:key encoding a NON-Ed25519
  //     multicodec (e.g. X25519 0xec01) as keyRef MUST NOT be coerced to Ed25519.
  {
    // did:key for X25519 uses multicodec 0xec01; a valid-looking but wrong-curve ref.
    const t = clone(signed);
    t.signature.keyRef = "did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc"; // known X25519 did:key example
    const r = await safeVerify(t);
    if (!r.ok) resisted("X25519 (wrong-curve) did:key keyRef rejected", `reason=${r.reason}${r.threw ? " (threw→fail)" : ""}`);
    else vulnerable("cross-curve confusion", "an X25519 did:key was accepted for Ed25519 verification");
  }

  // ======================================================================
  banner("GROUP 5 — Low-level Ed25519 / point probes");
  // ======================================================================

  // 5.1 All-zero signature over a real payload with A's key -> MUST be false.
  {
    const payload = computeSigningInput(baseManifest());
    let ok;
    try { ok = await verifyBytes(payload, new Uint8Array(64), A.rawPublicKey); } catch { ok = false; }
    if (ok === false) resisted("all-zero 64-byte signature rejected", "");
    else vulnerable("zero-signature accepted", "");
  }

  // 5.2 All-zero (small-order/identity) public key -> import rejects OR verify is
  //     false. Either way MUST NOT verify a real signature.
  {
    const payload = computeSigningInput(baseManifest());
    let verified = null;
    try {
      const pub = await importPublicKey(new Uint8Array(32));
      verified = await verifyBytes(payload, base64ToBytes(""), pub).catch(() => false);
    } catch (e) {
      verified = "import-rejected";
    }
    if (verified === "import-rejected" || verified === false)
      resisted("all-zero public key does not verify", verified === "import-rejected" ? "WebCrypto rejected the point at import" : "verify=false");
    else vulnerable("small-order public key", `unexpected verify result: ${verified}`);
  }

  // 5.3 SPKI with a corrupted DER prefix (wrong OID) as embedded key -> reject.
  {
    const t = clone(signed);
    const spki = base64ToBytes(signed.signature.publicKeySpkiB64);
    spki[6] = spki[6] ^ 0xff; // corrupt a prefix (OID) byte
    t.signature.publicKeySpkiB64 = bytesToBase64(spki);
    const r = await safeVerify(t);
    if (!r.ok) resisted("corrupted SPKI DER prefix rejected", `reason=${r.reason}${r.threw ? " (threw→fail)" : ""}`);
    else vulnerable("corrupted SPKI accepted", "");
  }

  // ======================================================================
  banner("GROUP 6 — Live emitter path cross-check (runtime, best-effort)");
  // ======================================================================
  // Guarded import: another worker may be editing the emitter; never crash.
  try {
    const emitter = await import("../manifest/um-manifest-emitter.mjs");
    const { manifest } = await emitter.buildAndSignManifest(
      { continuityId: "c", handoffId: "h", sourceLocationId: "a", targetLocationId: "b", ttlSeconds: 3600 },
      { bindDidSubject: true }
    );
    // The emitter strips [signature, presentationProof, postQuantumSignature]
    // UNCONDITIONALLY; verifyManifestProfileA excludes them (version-gated) — for a
    // real "0.4" manifest the two sets MUST agree, so it must self-verify.
    const r = await safeVerify(manifest);
    if (r.ok && r.checks.keyRefConsistency === "consistent")
      resisted("emitter sign path ↔ library verify path exclusion sets agree", "buildAndSignManifest output verifies via verifyManifestProfileA");
    else vulnerable("emitter/library exclusion mismatch", `emitter-signed manifest did not verify via the library (reason=${r.reason})`);

    // Tamper the emitter output's subject -> must fail.
    const t = clone(manifest); t.subject = String(t.subject) + "x";
    const rt = await safeVerify(t);
    if (!rt.ok) resisted("emitter-signed manifest tamper (subject) rejected", `reason=${rt.reason}`);
    else vulnerable("emitter tamper undetected", "");
  } catch (e) {
    console.log(`  SKIPPED    emitter cross-check (import failed: ${(e && e.message) || e})`);
  }

  // ======================================================================
  banner("VERDICT");
  // ======================================================================
  console.log(`\nchecks passed (RESISTED/EXPECTED): ${PASS}`);
  console.log(`hardening boundaries (input-discipline gaps, non-breaking): ${BOUND}`);
  console.log(`REAL vulnerabilities (⚠️ VULNERABLE): ${VULN}`);

  if (findings.length) {
    console.log("\n--- findings ---");
    for (const f of findings) console.log(`[${f.kind}] ${f.name}\n    ${f.detail}`);
  }

  if (VULN === 0) {
    console.log("\nKEYSTONE SOUND: no canonicalization collision the library is responsible for,");
    console.log("no undetected tamper, no fail-open check, no key/algorithm confusion.");
    if (BOUND > 0) console.log(`(${BOUND} honest input-discipline hardening note(s) recorded for a follow-up change — NOT crypto breaks.)`);
  } else {
    console.log(`\nKEYSTONE HAS ${VULN} REAL VULNERABILITY(IES) — see findings above.`);
  }

  process.exit(VULN === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("attack harness crashed:", e);
  process.exit(2);
});
