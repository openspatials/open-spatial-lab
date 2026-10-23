#!/usr/bin/env node
// ADVERSARIAL attack-vector harness (additive; READ-ONLY use
// of the module under test). This file MODIFIES NOTHING in
// jwe-sealed-facets.mjs or the signing library — it only imports
// their public API and TRIES TO BREAK the JWE sealed-facets crypto.
//
//   node web/manifest/attack-vectors.mjs
//
// Each vector states a SECURITY EXPECTATION and prints one of:
//   RESISTED               — the subsystem enforced the expectation (attack failed)
//   ⚠️  VULNERABLE (sev)    — the subsystem accepted the attack (finding + repro)
//   NOTE                   — a documented boundary / labeled scope (NOT a finding)
//
// Exit code: 0 when every hard vector RESISTS; 1 when any real finding stands.
//
// Attack classes (per the hardening brief; Base §2.3/§2.4 + RFC 7516):
//   (a) AAD / protected-header tamper decrypts (A256GCM AAD = protected header)
//   (b) authentication-tag forgery / truncation / ciphertext bit-flip undetected
//   (c) wrong-key or cross-facet decryption succeeds (isolation / CEK splice)
//   (d) malformed JWE accepted (5-member fail-closed) or decrypts to attacker plaintext
//   (e) IV / nonce reuse across encryptions (A256GCM nonce reuse = catastrophic)
//
// HONESTY BOUNDARY (enforced below): Q1 isolation is DECLARED Grade-1
// structural PREVIEW ("tests JSON-Schema shape, not the cryptographic isolation
// property"). Finding Q1 structural-only is NOT a vulnerability — it is labeled
// scope, scored NOTE. Likewise, ECDH-ES being an ANONYMOUS-SENDER scheme (any
// party holding the recipient's PUBLIC key can encrypt a well-formed JWE it will
// decrypt) is a standard, documented JWE property — the authenticity boundary is
// the manifest SIGNATURE, demonstrated in class (d). Only these are findings:
//   (a) tampered AAD/header still decrypts, (b) forged/truncated tag accepted,
//   (c) wrong-key/cross-facet plaintext recovered, (d) malformed JWE accepted by
//   the structural gate, (e) IV/nonce reuse in the emit path.

import {
  encryptJweForRecipients,
  decryptJweWithKey,
  generateRecipientKeyPair,
  makeSealedFacet,
  evaluateSealedFacets,
  evaluateJweSealedFacets,
  validateJweEntityShape,
  validateSealedFacetsStructural,
  checkIsolationShape,
  buildSealedCrossingFacets,
  decodeProtectedHeader,
  JWE_BASELINE_PROTECTED_B64U,
  JWE_BASELINE_ALG,
  JWE_BASELINE_ENC,
  JWE_REQUIRED_MEMBERS,
} from "./jwe-sealed-facets.mjs";

import { attachSignatureProfileA } from "../signing/um-signature-profile-a.mjs";
import { generateKeyPair } from "../signing/ed25519.mjs";
import { base64UrlToBytes, bytesToBase64Url, utf8Encode, utf8Decode } from "../signing/codecs.mjs";

// ---------------------------------------------------------------------------
// scoreboard
// ---------------------------------------------------------------------------
const resistedList = [];
const findings = []; // { id, title, severity, repro }
const notes = [];

function resisted(id, title, detail) {
  resistedList.push(id);
  console.log(`[${id}] ${title}`);
  console.log(`      RESISTED: ${detail}`);
}
function vulnerable(id, title, severity, repro) {
  findings.push({ id, title, severity, repro });
  console.log(`[${id}] ${title}`);
  console.log(`      ⚠️  VULNERABLE (${severity}): accepted / not enforced`);
  console.log(`      repro: ${repro}`);
}
function note(id, title, detail) {
  notes.push(id);
  console.log(`[${id}] ${title}`);
  console.log(`      NOTE: ${detail}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function baseManifest(overrides = {}) {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  return {
    "@context": "https://universalmanifest.net/ns/v0.4",
    "@id": `urn:uuid:${globalThis.crypto.randomUUID()}`,
    "@type": "um:Manifest",
    manifestVersion: "0.4",
    subject: "did:web:demo.local:user:attacker",
    issuedAt,
    expiresAt,
    ...overrides,
  };
}

/** Attempt a decrypt; classify without leaking the exception across vectors. */
async function tryDecrypt(jwe, key) {
  try {
    const payload = await decryptJweWithKey(jwe, key);
    return { ok: true, payload, error: null };
  } catch (e) {
    return { ok: false, payload: null, error: e.message };
  }
}

/** Re-encode a protected header object to a base64url string (attacker mutation). */
function encodeProtected(obj) {
  return bytesToBase64Url(utf8Encode(JSON.stringify(obj)));
}

// ===========================================================================
async function run() {
  console.log("runtime ADVERSARIAL attack-vector harness — JWE sealed facets");
  console.log("============================================================");
  console.log("target: web/manifest/jwe-sealed-facets.mjs (READ-ONLY) + runtime signing lib");
  console.log(`baseline pair (Base §2.4.1): ${JWE_BASELINE_ALG} / ${JWE_BASELINE_ENC}\n`);

  // Shared honest baseline: a REAL sealed facet that round-trips, so any later
  // "decrypted the attack" is a genuine break and not a plumbing artifact.
  const { facets, holderKeys } = await buildSealedCrossingFacets();
  const [govFacet, birthFacet] = facets;
  const [govKey, birthKey] = holderKeys;
  {
    const rt = await tryDecrypt(govFacet.entity, govKey);
    const ok = rt.ok && rt.payload?.documentType === "government-id";
    console.log("[AV-0] baseline: legitimate sealed facet round-trips under its holder key");
    console.log(
      `      ${ok ? "OK" : "BROKEN"}: gov facet decrypts to documentType=${rt.payload?.documentType ?? "(none)"} ` +
        `(pipeline is live; the breaks below are meaningful)\n`
    );
  }

  // =========================================================================
  // (a) AAD / PROTECTED-HEADER TAMPER  — A256GCM AAD = ASCII(protected b64u)
  //     Mutating the protected header after encryption MUST invalidate the tag.
  // =========================================================================
  console.log("-- (a) AAD / protected-header tamper -----------------------------------");

  // AV-a1: inject an extra header claim, KEEP alg/enc baseline so the alg gate
  //        passes — the ONLY thing standing between the attacker and plaintext
  //        is whether the AAD actually binds the header bytes.
  {
    const j = structuredClone(govFacet.entity);
    j.protected = encodeProtected({ alg: JWE_BASELINE_ALG, enc: JWE_BASELINE_ENC, zzz: "attacker-injected" });
    const r = await tryDecrypt(j, govKey);
    if (r.ok) {
      vulnerable("AV-a1", "protected-header extra-claim injection (alg/enc kept baseline)", "critical",
        `decrypt returned plaintext documentType=${r.payload?.documentType} despite mutated protected header — AAD does NOT bind the header`);
    } else {
      resisted("AV-a1", "protected-header extra-claim injection (alg/enc kept baseline)",
        `GCM auth failed — AAD binds the exact protected bytes (err: ${r.error.slice(0, 72)})`);
    }
  }

  // AV-a2: re-serialize the SAME semantic header with keys reordered — decodes
  //        to an equal object but different bytes ⇒ different AAD ⇒ tag must fail.
  {
    const j = structuredClone(govFacet.entity);
    j.protected = encodeProtected({ enc: JWE_BASELINE_ENC, alg: JWE_BASELINE_ALG }); // key order swapped
    const r = await tryDecrypt(j, govKey);
    if (r.ok) {
      vulnerable("AV-a2", "protected-header re-serialization (key order swap, same alg/enc)", "high",
        `decrypt returned plaintext despite different protected bytes — AAD compares decoded semantics, not bytes`);
    } else {
      resisted("AV-a2", "protected-header re-serialization (key order swap, same alg/enc)",
        `GCM auth failed — AAD is the exact base64url bytes (RFC 7516 §5.1), not the decoded object`);
    }
  }

  // AV-a3: DOWNGRADE enc A256GCM ⇒ A128GCM in the protected header. Must be
  //        refused at the alg gate (Base §2.4.2) — never a weaker decrypt.
  {
    const j = structuredClone(govFacet.entity);
    j.protected = encodeProtected({ alg: JWE_BASELINE_ALG, enc: "A128GCM" });
    const r = await tryDecrypt(j, govKey);
    if (r.ok) {
      vulnerable("AV-a3", "content-encryption downgrade A256GCM ⇒ A128GCM in protected header", "critical",
        `decrypt honored a downgraded enc — algorithm confusion`);
    } else {
      resisted("AV-a3", "content-encryption downgrade A256GCM ⇒ A128GCM in protected header",
        `refused (non-baseline pair ⇒ sealed entry, Base §2.4.2) — no weaker decrypt (err: ${r.error.slice(0, 60)})`);
    }
  }

  // AV-a4: whitespace-padded JSON — decodes equal, different bytes ⇒ AAD mismatch.
  {
    const j = structuredClone(govFacet.entity);
    j.protected = bytesToBase64Url(utf8Encode(`{ "alg": "${JWE_BASELINE_ALG}", "enc": "${JWE_BASELINE_ENC}" }`));
    const r = await tryDecrypt(j, govKey);
    if (r.ok) {
      vulnerable("AV-a4", "protected-header whitespace-injected JSON (semantically equal)", "high",
        `decrypt returned plaintext despite different header bytes — AAD not byte-exact`);
    } else {
      resisted("AV-a4", "protected-header whitespace-injected JSON (semantically equal)",
        `GCM auth failed — any header-byte change breaks the tag`);
    }
  }

  // AV-a5: evaluator layer — the tampered-protected facet stays SEALED (opaque),
  //        zero plaintext, never a crash, even with the right holder key held.
  {
    const j = structuredClone(govFacet);
    j.entity.protected = encodeProtected({ alg: JWE_BASELINE_ALG, enc: JWE_BASELINE_ENC, evil: 1 });
    const ev = await evaluateSealedFacets({ facets: [j] }, [govKey]);
    const sealed = ev.facetStatuses[0]?.status === "opaque" && ev.decrypted.size === 0;
    if (!sealed) {
      vulnerable("AV-a5", "evaluator on tampered-protected facet", "critical",
        `facet status=${ev.facetStatuses[0]?.status}, decrypted=${ev.decrypted.size} — plaintext exposed via evaluator`);
    } else {
      resisted("AV-a5", "evaluator on tampered-protected facet",
        `status=opaque, decrypted.size=0 — fail closed, plaintext never exposed`);
    }
  }

  // =========================================================================
  // (b) AUTH-TAG FORGERY / TRUNCATION / CIPHERTEXT BIT-FLIP
  // =========================================================================
  console.log("\n-- (b) authentication-tag forgery / truncation / ciphertext tamper -----");

  // AV-b1: single-bit ciphertext flip ⇒ GCM tag mismatch.
  {
    const j = structuredClone(govFacet.entity);
    const ct = base64UrlToBytes(j.ciphertext);
    ct[0] ^= 0x01;
    j.ciphertext = bytesToBase64Url(ct);
    const r = await tryDecrypt(j, govKey);
    r.ok
      ? vulnerable("AV-b1", "single-bit ciphertext flip", "critical", "GCM accepted a flipped ciphertext bit")
      : resisted("AV-b1", "single-bit ciphertext flip", "GCM auth failed — ciphertext integrity enforced");
  }

  // AV-b2: single-bit tag flip ⇒ auth mismatch.
  {
    const j = structuredClone(govFacet.entity);
    const tag = base64UrlToBytes(j.tag);
    tag[0] ^= 0x80;
    j.tag = bytesToBase64Url(tag);
    const r = await tryDecrypt(j, govKey);
    r.ok
      ? vulnerable("AV-b2", "single-bit authentication-tag flip", "critical", "GCM accepted a flipped tag bit")
      : resisted("AV-b2", "single-bit authentication-tag flip", "GCM auth failed — tag integrity enforced");
  }

  // AV-b3: TRUNCATE the 128-bit tag to 64 bits. If honored, an attacker halves
  //        the forgery work; the impl pins tagLength:128 so it must reject.
  {
    const j = structuredClone(govFacet.entity);
    const tag = base64UrlToBytes(j.tag).slice(0, 8); // 64-bit tag
    j.tag = bytesToBase64Url(tag);
    const r = await tryDecrypt(j, govKey);
    r.ok
      ? vulnerable("AV-b3", "authentication-tag truncation 128 ⇒ 64 bit", "critical",
          "decrypt accepted a 64-bit tag — truncation weakens forgery resistance")
      : resisted("AV-b3", "authentication-tag truncation 128 ⇒ 64 bit",
          "rejected — tagLength pinned to 128 bits, short tag fails");
  }

  // AV-b4: truncate the tag to 96 bits.
  {
    const j = structuredClone(govFacet.entity);
    j.tag = bytesToBase64Url(base64UrlToBytes(j.tag).slice(0, 12));
    const r = await tryDecrypt(j, govKey);
    r.ok
      ? vulnerable("AV-b4", "authentication-tag truncation 128 ⇒ 96 bit", "high", "decrypt accepted a 96-bit tag")
      : resisted("AV-b4", "authentication-tag truncation 128 ⇒ 96 bit", "rejected — short tag fails GCM");
  }

  // AV-b5: all-zero 128-bit tag (naive forgery).
  {
    const j = structuredClone(govFacet.entity);
    j.tag = bytesToBase64Url(new Uint8Array(16));
    const r = await tryDecrypt(j, govKey);
    r.ok
      ? vulnerable("AV-b5", "all-zero forged tag", "critical", "decrypt accepted an all-zero tag")
      : resisted("AV-b5", "all-zero forged tag", "rejected — forged tag fails GCM");
  }

  // AV-b6: OVER-LENGTH tag (append 16 bytes → 256-bit blob). Impl takes the last
  //        128 bits as the tag; those are attacker bytes ⇒ must fail.
  {
    const j = structuredClone(govFacet.entity);
    const tag = base64UrlToBytes(j.tag);
    const extended = new Uint8Array(tag.length + 16);
    extended.set(tag, 0);
    j.tag = bytesToBase64Url(extended);
    const r = await tryDecrypt(j, govKey);
    r.ok
      ? vulnerable("AV-b6", "over-length (extended) tag", "high", "decrypt accepted an extended tag")
      : resisted("AV-b6", "over-length (extended) tag", "rejected — extended tag fails GCM");
  }

  // AV-b7: evaluator layer — bit-flipped ciphertext stays SEALED (mirrors verify
  //        B9 independently: status opaque, zero plaintext).
  {
    const j = structuredClone(govFacet);
    const ct = base64UrlToBytes(j.entity.ciphertext);
    ct[ct.length - 1] ^= 0x40;
    j.entity.ciphertext = bytesToBase64Url(ct);
    const ev = await evaluateSealedFacets({ facets: [j] }, [govKey]);
    const sealed = ev.facetStatuses[0]?.status === "opaque" && ev.decrypted.size === 0;
    sealed
      ? resisted("AV-b7", "evaluator on bit-flipped ciphertext", "status=opaque, decrypted.size=0 — fail closed")
      : vulnerable("AV-b7", "evaluator on bit-flipped ciphertext", "critical",
          `status=${ev.facetStatuses[0]?.status} decrypted=${ev.decrypted.size} — plaintext exposed`);
  }

  // =========================================================================
  // (c) WRONG-KEY / CROSS-FACET ISOLATION
  // =========================================================================
  console.log("\n-- (c) wrong-key / cross-facet isolation -------------------------------");

  // AV-c1: right kid, WRONG private key ⇒ KDF derives wrong KEK ⇒ AES-KW unwrap
  //        integrity check fails (RFC 3394) ⇒ no plaintext.
  {
    const r = await tryDecrypt(govFacet.entity, { kid: govKey.kid, privateKey: birthKey.privateKey });
    r.ok
      ? vulnerable("AV-c1", "right kid + wrong private key", "critical",
          "decrypt succeeded with a non-matching private key — key binding broken")
      : resisted("AV-c1", "right kid + wrong private key",
          "AES-KW unwrap failed — wrong KEK, no plaintext (demo recipient keys are independent P-256 pairs)");
  }

  // AV-c2: cross-facet — the gov holder key aimed at the BIRTH facet (different
  //        kid) ⇒ no recipient entry ⇒ refused.
  {
    const r = await tryDecrypt(birthFacet.entity, govKey);
    r.ok
      ? vulnerable("AV-c2", "cross-facet: gov key on birth facet", "critical",
          "gov holder key decrypted the birth facet — cross-facet isolation broken")
      : resisted("AV-c2", "cross-facet: gov key on birth facet",
          `no recipient entry for the gov kid on the birth facet — refused (err: ${r.error.slice(0, 56)})`);
  }

  // AV-c3: CEK-SPLICE — splice the gov recipient entry (kid+epk+encrypted_key,
  //        which the attacker CAN unwrap) onto the BIRTH ciphertext. Unwrap
  //        yields the GOV CEK; GCM-decrypting BIRTH ciphertext with it must fail
  //        (the CEK is bound to its own ciphertext, not to the recipient entry).
  {
    const spliced = structuredClone(birthFacet.entity);
    spliced.recipients = structuredClone(govFacet.entity.recipients); // attacker holds govKey
    const r = await tryDecrypt(spliced, govKey);
    if (r.ok && r.payload?.documentType === "birth-record") {
      vulnerable("AV-c3", "CEK splice: gov recipient entry onto birth ciphertext", "critical",
        "birth plaintext recovered by splicing a decryptable recipient entry — CEK not bound to its ciphertext");
    } else {
      resisted("AV-c3", "CEK splice: gov recipient entry onto birth ciphertext",
        `unwrap gave the gov CEK, which fails GCM on the birth ciphertext — no cross-facet plaintext (err: ${(r.error || "wrong payload").slice(0, 48)})`);
    }
  }

  // AV-c4: multi-recipient JWE for r1,r2 — a NON-listed party r3 cannot decrypt.
  {
    const r1 = await generateRecipientKeyPair("did:web:demo.local:world-a#k1");
    const r2 = await generateRecipientKeyPair("did:web:demo.local:world-b#k1");
    const r3 = await generateRecipientKeyPair("did:web:demo.local:intruder#k1");
    const multi = await encryptJweForRecipients({ secret: "multi-payload" }, [r1, r2]);
    const asR3 = await tryDecrypt(multi, { kid: r3.kid, privateKey: r3.privateKey });
    // and r3 masquerading under r1's kid but with its own key:
    const masq = structuredClone(multi);
    const asR3MaskingR1 = await tryDecrypt(masq, { kid: r1.kid, privateKey: r3.privateKey });
    const bothRefused = !asR3.ok && !asR3MaskingR1.ok;
    bothRefused
      ? resisted("AV-c4", "multi-recipient: non-listed party r3 (direct + kid-masquerade)",
          "r3 has no entry (refused); masquerading under r1's kid with r3's key fails AES-KW unwrap")
      : vulnerable("AV-c4", "multi-recipient: non-listed party r3", "critical",
          `non-listed party decrypted (direct.ok=${asR3.ok}, masq.ok=${asR3MaskingR1.ok})`);
  }

  // AV-c5: attacker RELABELS the gov recipient kid to their own and supplies
  //        their OWN private key ⇒ ECDH against gov's epk gives a wrong Z ⇒ fail.
  {
    const intruder = await generateRecipientKeyPair("did:web:demo.local:intruder#relabel");
    const j = structuredClone(govFacet.entity);
    j.recipients[0].header.kid = intruder.kid; // relabel
    const r = await tryDecrypt(j, { kid: intruder.kid, privateKey: intruder.privateKey });
    r.ok
      ? vulnerable("AV-c5", "recipient kid relabel + attacker key", "critical",
          "relabeling the kid let an attacker key decrypt — kid is trusted as authorization")
      : resisted("AV-c5", "recipient kid relabel + attacker key",
          "kid is a label only; the attacker's key derives the wrong KEK against gov's epk — unwrap fails");
  }

  // AV-c6: epk SUBSTITUTION — replace the recipient epk with an attacker-generated
  //        ephemeral pub. encrypted_key was wrapped under the ORIGINAL epk's KEK,
  //        so unwrap must fail even with the right holder key.
  {
    const attackerEph = await generateRecipientKeyPair("did:web:demo.local:intruder#eph");
    const j = structuredClone(govFacet.entity);
    j.recipients[0].header.epk = attackerEph.publicJwk; // swap epk
    const r = await tryDecrypt(j, govKey);
    r.ok
      ? vulnerable("AV-c6", "ephemeral-public-key (epk) substitution", "critical",
          "swapping the epk still decrypted — epk not bound to the wrapped CEK")
      : resisted("AV-c6", "ephemeral-public-key (epk) substitution",
          "wrong epk ⇒ wrong ECDH Z ⇒ wrong KEK ⇒ AES-KW unwrap fails — no plaintext");
  }

  // AV-c7: INVALID-CURVE epk — corrupt the epk x-coordinate so the point is (very
  //        likely) off P-256. WebCrypto MUST reject the point on import; a naive
  //        ECDH that skipped point validation would risk a small-subgroup key leak.
  {
    const j = structuredClone(govFacet.entity);
    const badEpk = structuredClone(j.recipients[0].header.epk);
    const x = base64UrlToBytes(badEpk.x);
    x[0] ^= 0xff;
    x[x.length - 1] ^= 0xff; // perturb both ends → off-curve with overwhelming probability
    badEpk.x = bytesToBase64Url(x);
    j.recipients[0].header.epk = badEpk;
    const r = await tryDecrypt(j, govKey);
    r.ok
      ? vulnerable("AV-c7", "invalid-curve (off-curve) ephemeral public key", "critical",
          "decrypt honored an off-curve epk — ECDH point validation missing (invalid-curve attack surface)")
      : resisted("AV-c7", "invalid-curve (off-curve) ephemeral public key",
          `WebCrypto rejected the point on import / derived a wrong Z ⇒ no plaintext (err: ${r.error.slice(0, 48)})`);
  }

  // =========================================================================
  // (d) MALFORMED JWE ACCEPTED / DECRYPTS TO ATTACKER PLAINTEXT
  // =========================================================================
  console.log("\n-- (d) malformed-JWE acceptance / structural fail-closed ---------------");

  // AV-d1: each of the five required members deleted ⇒ structural reject AND
  //        decrypt refuses (fail closed; Base §2.3.2 / CONFORMANCE §6.6).
  {
    let allRejected = true;
    const detail = [];
    for (const member of JWE_REQUIRED_MEMBERS) {
      const j = structuredClone(govFacet.entity);
      delete j[member];
      const shape = validateJweEntityShape(j);
      const dec = await tryDecrypt(j, govKey);
      const rejected = shape.valid === false && dec.ok === false;
      if (!rejected) {
        allRejected = false;
        detail.push(`${member}: shape.valid=${shape.valid} decrypt.ok=${dec.ok}`);
      }
    }
    allRejected
      ? resisted("AV-d1", "delete each of the 5 required JWE members",
          "every deletion ⇒ structural reject + decrypt refused (5-member fail-closed)")
      : vulnerable("AV-d1", "delete each of the 5 required JWE members", "high",
          `accepted a JWE missing a required member — ${detail.join("; ")}`);
  }

  // AV-d2: empty-string members ⇒ structural reject (minLength:1 / isNonEmptyString).
  {
    let allRejected = true;
    const detail = [];
    for (const member of ["protected", "iv", "ciphertext", "tag"]) {
      const j = structuredClone(govFacet.entity);
      j[member] = "";
      const shape = validateJweEntityShape(j);
      if (shape.valid !== false) {
        allRejected = false;
        detail.push(member);
      }
    }
    allRejected
      ? resisted("AV-d2", "empty-string JWE members", "each empty member ⇒ structural reject (non-empty enforced)")
      : vulnerable("AV-d2", "empty-string JWE members", "high", `accepted empty member(s): ${detail.join(", ")}`);
  }

  // AV-d3: DOCUMENTED BOUNDARY — ECDH-ES is anonymous-sender. Any party holding
  //        the recipient's PUBLIC key can emit a well-formed JWE that decrypts to
  //        ATTACKER-CHOSEN plaintext. This is standard RFC 7516, NOT a module
  //        flaw: the raw JWE layer asserts confidentiality+integrity, NOT sender
  //        authenticity. The authenticity boundary is the manifest signature (d4).
  {
    const victim = await generateRecipientKeyPair("did:web:demo.local:victim#k1");
    const forged = await encryptJweForRecipients({ "@type": "um:Entity", evil: "attacker-chosen-plaintext" }, [
      { kid: victim.kid, publicJwk: victim.publicJwk },
    ]);
    const r = await tryDecrypt(forged, { kid: victim.kid, privateKey: victim.privateKey });
    note("AV-d3", "raw JWE has no sender authentication (ECDH-ES anonymous sender)",
      `a party with the recipient PUBLIC key produced a JWE decrypting to attacker plaintext ` +
        `(evil=${r.payload?.evil}). Standard RFC 7516 property; authenticity is the manifest signature — see AV-d4.`);
  }

  // AV-d4: SYSTEM boundary — swap an attacker-forged entity into a SIGNED
  //        manifest and evaluate. Profile-A signature covers the facets, so the
  //        forged facet ⇒ manifest REJECTED at Verify (never Stage-4 decrypted).
  {
    const signingKeys = await generateKeyPair();
    const signed = await attachSignatureProfileA(baseManifest({ facets: structuredClone(facets) }), signingKeys.seed);
    // attacker replaces gov facet's sealed entity with a forged one (post-signature)
    const victimForge = await encryptJweForRecipients({ "@type": "um:Entity", evil: "spoofed" }, [
      { kid: govKey.kid, publicJwk: (await generateRecipientKeyPair(govKey.kid)).publicJwk },
    ]);
    const tampered = structuredClone(signed);
    tampered.facets[0].entity = victimForge;
    const ev = await evaluateJweSealedFacets(tampered, { now: new Date().toISOString(), decryptionKeys: holderKeys });
    const rejectedOnSig = ev.result === "reject" && ev.receipt.signatureCheck === "invalid";
    rejectedOnSig
      ? resisted("AV-d4", "forged facet spliced into a signed manifest",
          "manifest signature covers the facets ⇒ Verify stage rejects (signatureCheck=invalid) before any Stage-4 decrypt")
      : vulnerable("AV-d4", "forged facet spliced into a signed manifest", "critical",
          `forged facet not caught: result=${ev.result} signatureCheck=${ev.receipt.signatureCheck} outcome=${ev.receipt.outcome}`);
  }

  // AV-d5: DOCUMENTED SCOPE — an empty recipients array. The structural validator
  //        mirrors schema.json $defs.jweEntity (recipients has NO minItems), so
  //        [] is schema-VALID; it yields NO kid ⇒ sealed entry (opaque), never a
  //        plaintext leak. Faithful-to-schema, not a fail-open — scored NOTE.
  {
    const j = structuredClone(govFacet.entity);
    j.recipients = [];
    const shape = validateJweEntityShape(j);
    const ev = await evaluateSealedFacets({ facets: [{ ...govFacet, entity: j }] }, [govKey]);
    const sealedNoLeak = ev.facetStatuses[0]?.status === "opaque" && ev.decrypted.size === 0;
    note("AV-d5", "empty recipients array (schema has no minItems)",
      `shape.valid=${shape.valid} (matches schema $defs.jweEntity — no minItems); evaluator ⇒ ` +
        `status=${ev.facetStatuses[0]?.status}, decrypted=${ev.decrypted.size} (${sealedNoLeak ? "sealed, no leak" : "LEAK"}). ` +
        `Structural laxity inherited from the schema, no crypto exposure.`);
  }

  // =========================================================================
  // (e) IV / NONCE REUSE  — A256GCM nonce reuse under one key is catastrophic
  // =========================================================================
  console.log("\n-- (e) IV / nonce reuse in the emit path -------------------------------");

  // AV-e1: encrypt the SAME plaintext to the SAME recipient twice ⇒ distinct iv,
  //        distinct ciphertext, distinct ephemeral-wrapped encrypted_key.
  {
    const rc = await generateRecipientKeyPair("did:web:demo.local:e1#k");
    const p = { "@type": "um:Entity", v: "same-plaintext" };
    const a = await encryptJweForRecipients(p, [{ kid: rc.kid, publicJwk: rc.publicJwk }]);
    const b = await encryptJweForRecipients(p, [{ kid: rc.kid, publicJwk: rc.publicJwk }]);
    const ivDistinct = a.iv !== b.iv;
    const ctDistinct = a.ciphertext !== b.ciphertext;
    const ekDistinct = a.recipients[0].encrypted_key !== b.recipients[0].encrypted_key;
    ivDistinct && ctDistinct && ekDistinct
      ? resisted("AV-e1", "two encryptions of identical plaintext/recipient",
          "distinct iv + distinct ciphertext + distinct wrapped CEK — fresh nonce & CEK per JWE")
      : vulnerable("AV-e1", "two encryptions of identical plaintext/recipient", "critical",
          `reuse detected: ivDistinct=${ivDistinct} ctDistinct=${ctDistinct} ekDistinct=${ekDistinct} — A256GCM nonce reuse`);
  }

  // AV-e2: 64 encryptions ⇒ all IVs unique (fresh 96-bit nonce each time).
  {
    const rc = await generateRecipientKeyPair("did:web:demo.local:e2#k");
    const ivs = new Set();
    for (let i = 0; i < 64; i++) {
      const j = await encryptJweForRecipients({ i }, [{ kid: rc.kid, publicJwk: rc.publicJwk }]);
      ivs.add(j.iv);
    }
    ivs.size === 64
      ? resisted("AV-e2", "64 encryptions — IV uniqueness", "all 64 IVs distinct (no deterministic/counter nonce reuse)")
      : vulnerable("AV-e2", "64 encryptions — IV uniqueness", "critical", `only ${ivs.size}/64 IVs distinct — nonce collision`);
  }

  // AV-e3: the demo's own two sealed facets carry distinct IVs (Q1 shape, by
  //        construction) — cross-facet nonce separation.
  {
    const distinct = govFacet.entity.iv !== birthFacet.entity.iv;
    distinct
      ? resisted("AV-e3", "demo gov/birth facets — distinct IVs", "gov.iv ≠ birth.iv (per-facet nonce separation)")
      : vulnerable("AV-e3", "demo gov/birth facets — distinct IVs", "critical", "the two demo facets reuse an IV");
  }

  // =========================================================================
  // HONESTY NOTE — Q1 isolation is DECLARED Grade-1 structural PREVIEW.
  // =========================================================================
  {
    const iso = checkIsolationShape({ facets });
    note("AV-Q1", "Q1 per-facet isolation is Grade-1 structural (labeled scope, NOT a finding)",
      `checkIsolationShape ⇒ valid=${iso.valid}, grade="${iso.grade}". Per Base §2.3.5 the residual gap ` +
        `is DECLARED: distinct kid/iv are necessary, not sufficient; true key isolation is a behavioral ` +
        `property outside the structural suite. Structural-only here is this suite's honest ceiling, not a vuln.`);
  }

  // =========================================================================
  console.log("\n============================================================");
  const hard = resistedList.length;
  console.log(`RESISTED (hard vectors): ${hard}   NOTES (documented scope): ${notes.length}   FINDINGS: ${findings.length}`);
  console.log(`RESISTED IDs: ${resistedList.join(", ")}`);
  console.log(`NOTE IDs:     ${notes.join(", ")}`);
  if (findings.length === 0) {
    console.log("\nVERDICT: SOUND — every hard attack vector RESISTED.");
    console.log("The A256GCM AAD binds the protected header (tamper ⇒ tag failure); tags are integrity-");
    console.log("enforced and non-truncatable; wrong-key/cross-facet/CEK-splice attempts recover no");
    console.log("plaintext; malformed JWEs fail closed structurally; the emit path never reuses an IV.");
    console.log("Facet authenticity rests on the manifest signature (AV-d4), which rejects forged facets.");
  } else {
    console.log(`\nVERDICT: ${findings.length} VULNERABILITY(IES) FOUND:`);
    for (const f of findings) console.log(`  [${f.id}] (${f.severity}) ${f.title}\n        repro: ${f.repro}`);
    process.exitCode = 1;
  }
}

run().catch((e) => {
  console.error(`HARNESS ERROR: ${e.stack || e.message}`);
  process.exitCode = 1;
});
