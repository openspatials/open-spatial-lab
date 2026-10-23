#!/usr/bin/env node
// ADVERSARIAL attack-vector harness (additive; READ-ONLY use
// of the module under test). This file MODIFIES NOTHING in holder-binding.mjs
// or the signing library — it only imports their public API and tries to
// BREAK the holder-binding + did-auth presentation-proof subsystem.
//
//   node web/manifest/attack-vectors.mjs
//
// Each vector states a SECURITY EXPECTATION and prints one of:
//   RESISTED               — the subsystem enforced the expectation (attack failed)
//   ⚠️  VULNERABLE (sev)    — the subsystem accepted the attack (finding + repro)
//
// Exit code: 0 when every hard vector RESISTS; 1 when any real finding stands.
//
// Attack classes (per the hardening brief + CONFORMANCE §9 / EXT-T1 threat model):
//   (a) challenge/audience replay accepted
//   (b) holder-binding forgery accepted (bind to a key the presenter does NOT control)
//   (c) a PREVIEW mode (sd-jwt-kb / bbs) coerced into verified / trust-elevating
//   (d) VP size-limit (G2) bypass
//   (e) missing-proof-when-challenged bypass
//
// HONESTY BOUNDARY (enforced below): sd-jwt-kb / bbs FAILING to verify is the
// CORRECT intended fail-closed PREVIEW posture and is scored RESISTED, never a
// finding. A finding is ONLY logged when the subsystem ACCEPTS something it must
// reject (elevates trust, verifies a forgery, or bypasses a limit).

import {
  makeReciprocalControlBinding,
  makeReciprocalControlBindingHardened,
  buildReciprocalHardenedMessage,
  RECIPROCAL_HARDENED_PROFILE,
  RECIPROCAL_REPLAYABLE_WARNING_CODE,
  buildHolderBinding,
  verifyHolderBindingForClaim,
  evaluateHolderBinding,
  evaluatePresentationProof,
  verifyDidAuthPresentationProof,
  attachPresentationProofDidAuth,
  issueVerifierChallenge,
  checkClaimProofSizeLimits,
  validateHolderBindingStructural,
  structuralVerdictHolderBinding,
  VP_EMBEDDED_LIMIT_BYTES,
  VP_TOTAL_LIMIT_BYTES,
} from "./holder-binding.mjs";

import { attachSignatureProfileA } from "../signing/um-signature-profile-a.mjs";
import { generateKeyPair, signBytes } from "../signing/ed25519.mjs";
import { publicKeyToDidKey } from "../signing/did.mjs";
import { bytesToBase64Url, utf8Encode } from "../signing/codecs.mjs";

// ---------------------------------------------------------------------------
// scoreboard
// ---------------------------------------------------------------------------
const resistedList = [];
const findings = []; // { id, title, severity, repro }

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
const NOW = new Date().toISOString();
function ctx(extra = {}) {
  return { now: NOW, maxSupportedTrustTier: 1, ...extra };
}

// ===========================================================================
async function run() {
  console.log("runtime ADVERSARIAL attack-vector harness");
  console.log("========================================");
  console.log("target: web/manifest/holder-binding.mjs (READ-ONLY) + runtime signing lib\n");

  // Shared honest baseline: prove the pipeline actually VERIFIES a legitimate
  // binding, so that any later "verified" on a forgery is meaningful and not a
  // harness plumbing artifact.
  const good = await generateKeyPair();
  const goodBoundKey = await generateKeyPair();
  {
    const m = baseManifest({ requiredTrustTier: 1 });
    const { binding } = await makeReciprocalControlBinding({
      manifestId: m["@id"],
      subjectPrivateKey: good.privateKey,
      boundDidPrivateKey: goodBoundKey.privateKey,
    });
    m.claims = [{ "@id": "urn:um:claim:legit", "@type": "membership.organization", issuer: "did:web:example-org.com", requiredTrustTier: 1, holderBinding: binding }];
    const signed = await attachSignatureProfileA(m, good.seed);
    const r = await evaluateHolderBinding(signed, ctx());
    const ok = r.receipt.holderBindingStatus === "verified" && r.receipt.effectiveTrustTier === 1;
    console.log(`[AV-0] baseline: legitimate single-holder reciprocal binding verifies`);
    console.log(`      ${ok ? "OK" : "BROKEN"}: holderBindingStatus=${r.receipt.holderBindingStatus} tier=${r.receipt.effectiveTrustTier} (pipeline is live; forgeries below are meaningful)\n`);
  }

  // -------------------------------------------------------------------------
  // (a) CHALLENGE / AUDIENCE REPLAY
  // -------------------------------------------------------------------------
  const k = await generateKeyPair();
  const signedPlain = await attachSignatureProfileA(baseManifest(), k.seed);
  const ch1 = issueVerifierChallenge({ audience: "did:web:demo.local:world:A1" });
  const presented = await attachPresentationProofDidAuth(signedPlain, k.privateKey, {
    challenge: ch1.verifierChallenge,
    audience: ch1.verifierAudience,
  });

  // AV-1 — replay a valid proof under a DIFFERENT verifier challenge.
  {
    const ch2 = issueVerifierChallenge({ audience: ch1.verifierAudience });
    const r = await evaluateHolderBinding(presented, ctx({ verifierChallenge: ch2.verifierChallenge, verifierAudience: ch1.verifierAudience }));
    const rejected = r.result === "reject" && r.receipt.presentationProofStatus === "failed";
    if (rejected) resisted("AV-1", "challenge replay: valid validation for C1 presented under fresh challenge C2", "presentationProofStatus=failed + rejected (validation.challenge ≠ verifier nonce)");
    else vulnerable("AV-1", "challenge replay", "high", `accepted a validation bound to a stale challenge (status=${r.receipt.presentationProofStatus}, result=${r.result})`);
  }

  // AV-2 — SWAP the challenge string to match the verifier, keep the old proofValue.
  {
    const ch2 = issueVerifierChallenge({ audience: ch1.verifierAudience });
    const forged = { ...presented, presentationProof: { ...presented.presentationProof, challenge: ch2.verifierChallenge } };
    const r = await evaluateHolderBinding(forged, ctx({ verifierChallenge: ch2.verifierChallenge, verifierAudience: ch1.verifierAudience }));
    const rejected = r.result === "reject" && r.receipt.presentationProofStatus === "failed";
    if (rejected) resisted("AV-2", "challenge substitution: overwrite validation.challenge=C2 (string match) but keep C1's proofValue", "did-auth crypto recomputes over C2 ⇒ signature fails ⇒ rejected (challenge is cryptographically bound)");
    else vulnerable("AV-2", "challenge substitution", "critical", `string-matched challenge accepted without re-signing (status=${r.receipt.presentationProofStatus})`);
  }

  // AV-3 — SWAP the audience string to match a different verifier, keep old proofValue.
  {
    const forged = { ...presented, presentationProof: { ...presented.presentationProof, audience: "did:web:demo.local:world:A2" } };
    const r = await evaluateHolderBinding(forged, ctx({ verifierChallenge: ch1.verifierChallenge, verifierAudience: "did:web:demo.local:world:A2" }));
    const rejected = r.result === "reject" && r.receipt.presentationProofStatus === "failed";
    if (rejected) resisted("AV-3", "audience substitution: overwrite validation.audience=A2 (string match) but keep A1's proofValue", "did-auth crypto recomputes over A2 ⇒ signature fails ⇒ rejected (audience is cryptographically bound)");
    else vulnerable("AV-3", "audience substitution", "critical", `string-matched audience accepted without re-signing (status=${r.receipt.presentationProofStatus})`);
  }

  // AV-4 — transplant a valid did-auth proof onto a DIFFERENT manifest (same key).
  {
    const other = await attachSignatureProfileA(baseManifest({ subject: "did:web:demo.local:user:victim" }), k.seed);
    const transplant = { ...other, presentationProof: presented.presentationProof };
    const r = await evaluateHolderBinding(transplant, ctx({ verifierChallenge: ch1.verifierChallenge, verifierAudience: ch1.verifierAudience }));
    const rejected = r.result === "reject" && r.receipt.presentationProofStatus === "failed";
    if (rejected) resisted("AV-4", "did-auth validation transplant: move validation to a different manifest, same challenge/audience/key", "validation binds SHA-256(signing-input) → different manifest content ⇒ hash differs ⇒ rejected");
    else vulnerable("AV-4", "did-auth validation transplant", "high", `validation accepted on a manifest it was not issued for (status=${r.receipt.presentationProofStatus})`);
  }

  // -------------------------------------------------------------------------
  // (b) HOLDER-BINDING FORGERY  — the primary attack
  // -------------------------------------------------------------------------

  // AV-5 — reciprocal-control boundDidProof TRANSPLANT / replay forgery.
  // ORIGINAL FINDING (HIGH): both proofs sign only UTF-8(manifest @id), so a
  // published boundDidProof B = sig_D(utf8(X)) transplants into an attacker-authored
  // manifest that reuses @id=X, silently forging a "verified" Tier-1 binding to a DID
  // (D) the attacker does not control. FIXED as a DESIGN CHANGE (see FIX-):
  //   (1) The literal EXT-T1 §T1.1.1 recipe is INHERENTLY replayable and the external
  //       suite + verify expect it to verify, so we STAY CONFORMANT
  //       (holderBindingStatus stays "verified") but STOP SILENTLY OVERCLAIMING — the
  //       receipt MUST now carry um:warning:reciprocal-binding-replayable.
  //   (2) The opt-in HARDENED profile (nonce + BOTH DIDs + @id, subject side bound to
  //       the ACTUAL embedded key) MUST verify for the real holder yet REJECT the same
  //       transplant/replay.
  // This vector RESISTS iff spec-mode is verified-BUT-FLAGGED AND hardened-mode resists.
  {
    // ---- (1) spec-mode forgery: still "verified" but no longer SILENT ----------
    const victimSubject = await generateKeyPair();
    const victimBound = await generateKeyPair(); // == D; attacker never gets this private key
    const X = `urn:uuid:${globalThis.crypto.randomUUID()}`;
    const { binding: victimBinding, boundDid: capturedBoundDid } = await makeReciprocalControlBinding({
      manifestId: X,
      subjectPrivateKey: victimSubject.privateKey,
      boundDidPrivateKey: victimBound.privateKey,
    });
    const capturedBoundDidProof = victimBinding.boundDidProof; // sig_D(utf8(X)) — public

    const attackerKey = await generateKeyPair(); // attacker controls ONLY this key, NOT D
    const forgedBinding = {
      mode: "reciprocal-control",
      boundDid: capturedBoundDid, // D — attacker does NOT control it
      subjectProof: bytesToBase64Url(await signBytes(utf8Encode(X), attackerKey.privateKey)),
      boundDidProof: capturedBoundDidProof, // REPLAYED from the victim's published manifest
    };
    const attackerManifest = baseManifest({ "@id": X, requiredTrustTier: 1, subject: "did:web:attacker.example:user:mallory" });
    attackerManifest.claims = [{
      "@id": "urn:um:claim:forged-reciprocal",
      "@type": "membership.organization",
      issuer: "did:web:example-org.com",
      requiredTrustTier: 1,
      holderBinding: forgedBinding,
    }];
    const attackerSigned = await attachSignatureProfileA(attackerManifest, attackerKey.seed);
    const rSpec = await evaluateHolderBinding(attackerSigned, ctx());
    const specVerified = rSpec.receipt.holderBindingStatus === "verified" && rSpec.receipt.effectiveTrustTier >= 1;
    const specFlagged = (rSpec.receipt.warnings || []).some((w) => w.code === RECIPROCAL_REPLAYABLE_WARNING_CODE);

    // ---- (2) hardened profile: positive control + the same transplant/replay ----
    const hSubject = await generateKeyPair();
    const hBound = await generateKeyPair(); // == D' (attacker never gets this)
    const HX = `urn:uuid:${globalThis.crypto.randomUUID()}`;
    const { binding: hVictimBinding, boundDid: hBoundDid, nonce: hNonce } = await makeReciprocalControlBindingHardened({
      manifestId: HX,
      subjectPrivateKey: hSubject.privateKey,
      boundDidPrivateKey: hBound.privateKey,
    });
    const hVictimManifest = baseManifest({ "@id": HX, requiredTrustTier: 1, subject: "did:web:victim.example" });
    hVictimManifest.claims = [{
      "@id": "urn:um:claim:hardened-legit",
      "@type": "membership.organization",
      issuer: "did:web:example-org.com",
      requiredTrustTier: 1,
      holderBinding: hVictimBinding,
    }];
    const hVictimSigned = await attachSignatureProfileA(hVictimManifest, hSubject.seed);
    const hLegit = await evaluateHolderBinding(hVictimSigned, ctx());
    const hardenedVerifies =
      hLegit.receipt.holderBindingStatus === "verified" &&
      hLegit.receipt.effectiveTrustTier >= 1 &&
      !(hLegit.receipt.warnings || []).some((w) => w.code === RECIPROCAL_REPLAYABLE_WARNING_CODE); // no replay warning on the hardened path

    // attacker replays the hardened boundDidProof (sig_D' over the VICTIM's hardened
    // message) into their OWN manifest, and even signs the subject side CORRECTLY over
    // the hardened message with their own key — only the bound side is transplanted.
    const hAttacker = await generateKeyPair();
    const hAttackerDidKey = publicKeyToDidKey(hAttacker.rawPublicKey);
    const hAttackerMsg = buildReciprocalHardenedMessage({
      nonce: hNonce, // replayed nonce
      subjectDidKey: hAttackerDidKey, // the verifier will re-derive THIS from the embedded key
      boundDid: hBoundDid,
      manifestId: HX,
    });
    const hForgedBinding = {
      mode: "reciprocal-control",
      bindingProfile: RECIPROCAL_HARDENED_PROFILE,
      nonce: hNonce,
      boundDid: hBoundDid, // D' — attacker does NOT control it
      subjectProof: bytesToBase64Url(await signBytes(hAttackerMsg, hAttacker.privateKey)), // subject side is VALID
      boundDidProof: hVictimBinding.boundDidProof, // REPLAYED — committed to the victim's subject key
    };
    const hAttackerManifest = baseManifest({ "@id": HX, requiredTrustTier: 1, subject: "did:web:attacker.example" });
    hAttackerManifest.claims = [{
      "@id": "urn:um:claim:hardened-forged",
      "@type": "membership.organization",
      issuer: "did:web:example-org.com",
      requiredTrustTier: 1,
      holderBinding: hForgedBinding,
    }];
    const hAttackerSigned = await attachSignatureProfileA(hAttackerManifest, hAttacker.seed);
    const hForgeCheck = await verifyHolderBindingForClaim(hAttackerSigned, hAttackerSigned.claims[0]);
    const hForge = await evaluateHolderBinding(hAttackerSigned, ctx());
    const hardenedResists =
      hForgeCheck.status !== "verified" &&
      hForge.receipt.holderBindingStatus !== "verified" &&
      !((hForge.receipt.claimStatuses || []).some((c) => c.status === "bound" && c.tier >= 1));

    const ok = specVerified && specFlagged && hardenedVerifies && hardenedResists;
    if (ok) {
      resisted(
        "AV-5",
        "reciprocal-control replay — spec-mode verified-BUT-FLAGGED + hardened profile RESISTS",
        `spec T1.1.1 forgery still holderBindingStatus="verified" (stays conformant) BUT the receipt now carries ${RECIPROCAL_REPLAYABLE_WARNING_CODE} (no silent Tier-0→Tier-1 overclaim); the opt-in hardened profile (${RECIPROCAL_HARDENED_PROFILE}) verifies for the real holder yet REJECTS the same transplant/replay (forged hbStatus=${hForge.receipt.holderBindingStatus}, claimCheck=${hForgeCheck.status}). AV-5 downgraded from a SILENT forgery to a disclosed limitation with an available fix.`
      );
    } else {
      vulnerable(
        "AV-5",
        "reciprocal-control replay design change incomplete",
        "high",
        `expected spec-mode verified+FLAGGED and hardened-mode resists, got specVerified=${specVerified} specFlagged=${specFlagged} hardenedVerifies=${hardenedVerifies} hardenedResists=${hardenedResists} (spec hbStatus=${rSpec.receipt.holderBindingStatus}, hardened-forge hbStatus=${hForge.receipt.holderBindingStatus})`
      );
    }
  }

  // AV-5b — same-@id cross-manifest reuse WITHOUT any attacker subject key work:
  // demonstrate the boundDidProof alone is the transplantable secret-less token by
  // pairing it with a fresh attacker subject over the SAME @id on unrelated content.
  {
    const victimBoundK = await generateKeyPair(); // D
    const X = `urn:uuid:${globalThis.crypto.randomUUID()}`;
    const victimSubjK = await generateKeyPair();
    const { binding } = await makeReciprocalControlBinding({ manifestId: X, subjectPrivateKey: victimSubjK.privateKey, boundDidPrivateKey: victimBoundK.privateKey });
    const capturedProof = binding.boundDidProof; // sig_D(utf8(X))
    const capturedBoundDid = publicKeyToDidKey(victimBoundK.rawPublicKey);

    const mallory = await generateKeyPair();
    const mm = baseManifest({ "@id": X, requiredTrustTier: 1, subject: "did:web:evil.example" });
    mm.claims = [{ "@id": "urn:um:claim:x", "@type": "membership.organization", issuer: "did:web:example-org.com", requiredTrustTier: 1, holderBinding: {
      mode: "reciprocal-control",
      boundDid: capturedBoundDid,
      subjectProof: bytesToBase64Url(await signBytes(utf8Encode(X), mallory.privateKey)),
      boundDidProof: capturedProof,
    } }];
    const mmSigned = await attachSignatureProfileA(mm, mallory.seed);
    const r = await evaluateHolderBinding(mmSigned, ctx());
    const verified = r.receipt.holderBindingStatus === "verified";
    if (verified) note("AV-5b", "confirmatory: independent second forgery reuses the same captured boundDidProof", `a second unrelated attacker also reaches holderBindingStatus="verified" bound to ${capturedBoundDid.slice(0, 24)}… — the captured validation is a reusable bearer token (reinforces AV-5)`);
    else resisted("AV-5b", "confirmatory second reciprocal forgery", `rejected (hbStatus=${r.receipt.holderBindingStatus})`);
  }

  // -------------------------------------------------------------------------
  // (c) PREVIEW-MODE COERCION  (sd-jwt-kb / bbs must NEVER report verified)
  // -------------------------------------------------------------------------

  // AV-6 — sd-jwt-kb holder binding, decorated with reciprocal fields, on a Tier-1
  // claim: try to trick the evaluator into the crypto path / a verified status.
  {
    const m = baseManifest({ requiredTrustTier: 1 });
    const bK = await generateKeyPair();
    // Attach REAL reciprocal proofs too, but keep mode = sd-jwt-kb (mode confusion attempt).
    const recip = await makeReciprocalControlBinding({ manifestId: m["@id"], subjectPrivateKey: k.privateKey, boundDidPrivateKey: bK.privateKey });
    const confused = { mode: "sd-jwt-kb", cnfThumbprint: "sha256-x", boundDid: recip.binding.boundDid, subjectProof: recip.binding.subjectProof, boundDidProof: recip.binding.boundDidProof };
    m.claims = [{ "@id": "urn:um:claim:sdjwt", "@type": "membership.organization", issuer: "did:web:example-org.com", requiredTrustTier: 1, holderBinding: confused }];
    const signed = await attachSignatureProfileA(m, k.seed);
    const r = await evaluateHolderBinding(signed, ctx());
    const safe = r.receipt.holderBindingStatus === "unsupported-mode" && r.receipt.holderBindingStatus !== "verified" && r.receipt.effectiveTrustTier === 0;
    if (safe) resisted("AV-6", "sd-jwt-kb binding decorated with real reciprocal validation (mode confusion)", 'dispatch is by declared mode ⇒ "unsupported-mode", Tier-0 cap; the smuggled reciprocal validation are ignored, never verified');
    else vulnerable("AV-6", "sd-jwt-kb mode confusion", "high", `sd-jwt-kb binding reached status=${r.receipt.holderBindingStatus} tier=${r.receipt.effectiveTrustTier}`);
  }

  // AV-7 — bbs-holder-commitment: same, must stay unsupported-mode / Tier-0.
  {
    const m = baseManifest({ requiredTrustTier: 1 });
    m.claims = [{ "@id": "urn:um:claim:bbs", "@type": "membership.organization", issuer: "did:web:example-org.com", requiredTrustTier: 1, holderBinding: buildHolderBinding("bbs-holder-commitment", { commitment: "zC", proofValue: "u2V0D" }) }];
    const signed = await attachSignatureProfileA(m, k.seed);
    const r = await evaluateHolderBinding(signed, ctx());
    const safe = r.receipt.holderBindingStatus === "unsupported-mode" && r.receipt.effectiveTrustTier === 0;
    if (safe) resisted("AV-7", "bbs-holder-commitment binding on a Tier-1 claim", '"unsupported-mode", Tier-0 cap — never verified (no BLS12-381/BBS+ crypto to coerce)');
    else vulnerable("AV-7", "bbs-holder-commitment coercion", "high", `reached status=${r.receipt.holderBindingStatus} tier=${r.receipt.effectiveTrustTier}`);
  }

  // AV-8 — at-risk presentation proofType (sd-jwt-kb / bbs-derived) with MATCHING
  // challenge/audience + a well-formed proofValue: must fail closed, never verified.
  {
    const chX = issueVerifierChallenge({ audience: "did:web:demo.local:world:A1" });
    let allSafe = true;
    const detail = [];
    for (const proofType of ["sd-jwt-kb", "bbs-derived"]) {
      const atRisk = {
        ...signedPlain,
        presentationProof: { proofType, challenge: chX.verifierChallenge, audience: chX.verifierAudience, created: NOW, proofValue: bytesToBase64Url(new Uint8Array(64)) },
      };
      const r = await evaluateHolderBinding(atRisk, ctx({ verifierChallenge: chX.verifierChallenge, verifierAudience: chX.verifierAudience }));
      const safe = r.result === "reject" && r.receipt.presentationProofStatus === "failed";
      allSafe = allSafe && safe;
      detail.push(`${proofType}:${r.receipt.presentationProofStatus}`);
    }
    if (allSafe) resisted("AV-8", "at-risk presentation proofType with matching challenge/audience", `both fail closed → status=failed + rejected, never verified (${detail.join(", ")})`);
    else vulnerable("AV-8", "at-risk proofType coercion", "critical", `an at-risk proofType did NOT fail closed (${detail.join(", ")})`);
  }

  // AV-9 — relabel a CRYPTOGRAPHICALLY-VALID did-auth proof as sd-jwt-kb (downgrade
  // confusion): the evaluator must not run did-auth crypto for a non-did-auth label.
  {
    const relabeled = { ...presented, presentationProof: { ...presented.presentationProof, proofType: "sd-jwt-kb" } };
    const r = await evaluateHolderBinding(relabeled, ctx({ verifierChallenge: ch1.verifierChallenge, verifierAudience: ch1.verifierAudience }));
    const safe = r.result === "reject" && r.receipt.presentationProofStatus === "failed";
    // cross-check: the SAME proofValue verifies as did-auth (so only the label changed)
    const asDidAuth = await verifyDidAuthPresentationProof(presented, presented.presentationProof);
    if (safe && asDidAuth) resisted("AV-9", "valid did-auth validation relabeled sd-jwt-kb (downgrade confusion)", "same proofValue verifies as did-auth, but relabeled it fails closed → rejected (no cross-type acceptance)");
    else if (!safe) vulnerable("AV-9", "proofType downgrade confusion", "high", `relabeled validation reached status=${r.receipt.presentationProofStatus}`);
    else note("AV-9", "downgrade confusion", "control validation did not verify as did-auth; label test inconclusive but relabeled path still rejected");
  }

  // -------------------------------------------------------------------------
  // (e) MISSING-WHEN-CHALLENGED BYPASS
  // -------------------------------------------------------------------------
  {
    const chX = issueVerifierChallenge({ audience: "did:web:demo.local:world:A1" });
    const variants = [
      ["absent", (m) => { const c = { ...m }; delete c.presentationProof; return c; }],
      ["null", (m) => ({ ...m, presentationProof: null })],
      ["empty-string", (m) => ({ ...m, presentationProof: "" })],
      ["false", (m) => ({ ...m, presentationProof: false })],
      ["empty-object", (m) => ({ ...m, presentationProof: {} })],
      ["empty-array", (m) => ({ ...m, presentationProof: [] })],
      ["number", (m) => ({ ...m, presentationProof: 1 })],
    ];
    let anyAccepted = false;
    const detail = [];
    for (const [label, mut] of variants) {
      const cand = mut(signedPlain);
      const r = await evaluateHolderBinding(cand, ctx({ verifierChallenge: chX.verifierChallenge, verifierAudience: chX.verifierAudience }));
      const accepted = r.result !== "reject";
      anyAccepted = anyAccepted || accepted;
      detail.push(`${label}:${r.result}/${r.receipt.presentationProofStatus ?? "—"}`);
    }
    if (!anyAccepted) resisted("AV-10", "missing/degenerate presentationProof under an issued challenge (7 shapes)", `every shape rejected (missing-required or structural/failed) — no bypass: ${detail.join(", ")}`);
    else vulnerable("AV-10", "missing-validation-when-challenged bypass", "critical", `a degenerate validation shape was accepted under an issued challenge: ${detail.join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // (d) VP SIZE-LIMIT (G2) BYPASS
  // -------------------------------------------------------------------------

  // AV-11 — boundary probe: exactly at limit accepted, limit+1 rejected (no off-by-one).
  {
    // JSON.stringify({type,padding}) overhead; size the padding so the entry is exactly VP_EMBEDDED_LIMIT_BYTES.
    const shell = JSON.stringify({ type: "VerifiablePresentation", padding: "" }).length; // bytes of the wrapper
    const atLimitPad = "x".repeat(VP_EMBEDDED_LIMIT_BYTES - shell);
    const overPad = "x".repeat(VP_EMBEDDED_LIMIT_BYTES - shell + 1);
    const mk = (pad) => ({ claims: [{ "@type": "membership.organization", issuer: "x", claimProof: { type: "VerifiablePresentation", padding: pad } }] });
    const at = checkClaimProofSizeLimits(mk(atLimitPad));
    const over = checkClaimProofSizeLimits(mk(overPad));
    const correct = at.valid === true && at.totalBytes === VP_EMBEDDED_LIMIT_BYTES && over.valid === false && over.errors.some((e) => e.includes("50 KB"));
    if (correct) resisted("AV-11", "50 KB per-VP boundary (off-by-one probe)", `exactly ${VP_EMBEDDED_LIMIT_BYTES}B accepted, ${VP_EMBEDDED_LIMIT_BYTES + 1}B rejected — inclusive "at most 50 KB", no off-by-one`);
    else vulnerable("AV-11", "50 KB boundary off-by-one", "low", `at=${at.valid}/${at.totalBytes}B over=${over.valid} — boundary handling deviates from "at most 50 KB"`);
  }

  // AV-12 — oversize embedded object VP (> 50 KB) end-to-end through the verdict.
  {
    const m = baseManifest();
    m.claims = [{ "@id": "urn:um:claim:big", "@type": "membership.organization", issuer: "did:web:example-org.com", claimProof: { type: "VerifiablePresentation", padding: "x".repeat(60 * 1024) } }];
    const signed = await attachSignatureProfileA(m, k.seed);
    const v = await structuralVerdictHolderBinding(signed);
    const rejected = v.result === "reject" && v.reasons.some((r) => r.includes("50 KB"));
    if (rejected) resisted("AV-12", "embedded object VP > 50 KB", "structural verdict = reject (per-VP cap enforced end-to-end)");
    else vulnerable("AV-12", "oversize embedded VP accepted", "medium", `60 KB embedded VP accepted (result=${v.result})`);
  }

  // AV-13 — 500 KB TOTAL across many sub-50 KB object VPs.
  {
    const m = baseManifest();
    m.claims = Array.from({ length: 12 }, (_, i) => ({ "@id": `urn:um:claim:t${i}`, "@type": "membership.organization", issuer: "x", claimProof: { type: "VerifiablePresentation", padding: "x".repeat(45 * 1024) } }));
    const sizes = checkClaimProofSizeLimits(m);
    const rejected = sizes.valid === false && sizes.errors.some((e) => e.includes("500 KB")) && sizes.totalBytes > VP_TOTAL_LIMIT_BYTES;
    if (rejected) resisted("AV-13", "aggregate > 500 KB across 12 sub-50 KB VPs", `total cap enforced (measured ${sizes.totalBytes}B > ${VP_TOTAL_LIMIT_BYTES}B)`);
    else vulnerable("AV-13", "aggregate VP cap bypass", "medium", `${sizes.totalBytes}B accepted across claims`);
  }

  // AV-14 — SIZE-LIMIT BYPASS via string-typed claimProof: a claimProof that is a
  // (non-URI) string is treated as a "URI reference" and skipped entirely by the
  // byte counter, so an arbitrarily large embedded string evades BOTH the 50 KB and
  // 500 KB caps. Same for an array whose entries are strings.
  {
    const giant = "x".repeat(600 * 1024); // 600 KB, well over the 500 KB total cap
    const asString = checkClaimProofSizeLimits({ claims: [{ "@type": "membership.organization", issuer: "x", claimProof: giant }] });
    const asArray = checkClaimProofSizeLimits({ claims: [{ "@type": "membership.organization", issuer: "x", claimProof: [giant, giant] }] });
    // end-to-end: does a signed manifest with a 600 KB string claimProof pass the verdict?
    const m = baseManifest();
    m.claims = [{ "@id": "urn:um:claim:strbypass", "@type": "membership.organization", issuer: "did:web:example-org.com", claimProof: giant }];
    const signed = await attachSignatureProfileA(m, k.seed);
    const verdict = await structuralVerdictHolderBinding(signed);
    const bypassed = asString.valid === true && asString.totalBytes === 0 && asArray.valid === true && verdict.result === "accept";
    if (bypassed) {
      vulnerable(
        "AV-14",
        "VP size-limit bypass via string-typed claimProof",
        "medium",
        `a 600 KB (and array-of-strings) claimProof is counted as 0 bytes and ACCEPTED end-to-end (structuralVerdict=accept) — the 50 KB/500 KB caps only apply to object entries, and there is NO URI validation or length bound on string claimProofs, so unbounded data rides in as a "URI reference". Note: EXT-T1 T1.5.1 scopes the cap to "embedded VP" objects and lets URI strings be fetch-on-demand, so this is a hardening gap (no length/format guard) rather than a literal spec violation.`
      );
    } else {
      resisted("AV-14", "string-typed claimProof size bypass", `string claimProof handled safely (asString.valid=${asString.valid}, verdict=${verdict.result})`);
    }
  }

  // AV-15 — audience-binding is only enforced when the verifier populates
  // verifierAudience (defense-in-depth observation, not an acceptance of a forgery).
  {
    // proof made for A1; verifier issues the SAME challenge but sets NO audience.
    const r = await evaluateHolderBinding(presented, ctx({ verifierChallenge: ch1.verifierChallenge /* verifierAudience omitted */ }));
    const acceptedWithoutAudienceCheck = r.receipt.presentationProofStatus === "verified";
    if (acceptedWithoutAudienceCheck) {
      note("AV-15", "audience binding is verifier-optional", "when context.verifierAudience is omitted, the string audience-match is skipped and only challenge uniqueness binds the verifier; the did-auth crypto still binds validation.audience, so this is defense-in-depth only (a verifier SHOULD always pin verifierAudience). Not a forgery acceptance.");
    } else {
      resisted("AV-15", "audience binding when verifier omits verifierAudience", `still constrained (status=${r.receipt.presentationProofStatus})`);
    }
  }

  // -------------------------------------------------------------------------
  // summary
  // -------------------------------------------------------------------------
  console.log("\n========================================");
  console.log(`RESISTED: ${resistedList.length}   FINDINGS: ${findings.length}`);
  if (findings.length === 0) {
    console.log("VERDICT: SOUND — every hard attack vector resisted.");
  } else {
    console.log("VERDICT: FINDINGS — ranked:");
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    for (const f of [...findings].sort((a, b) => order[a.severity] - order[b.severity])) {
      console.log(`  - [${f.id}] (${f.severity.toUpperCase()}) ${f.title}`);
    }
    process.exitCode = 1;
  }
}

run().catch((e) => {
  console.error(`HARNESS ERROR: ${e.stack || e.message}`);
  process.exitCode = 2;
});
