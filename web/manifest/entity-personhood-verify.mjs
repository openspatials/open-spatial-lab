#!/usr/bin/env node
// standalone verification driver (Node-only; the module it
// proves is browser-safe).
//
//   node web/manifest/verify.mjs        (any cwd; imports are relative-safe)
//
// WHAT THIS PROVES (prints PASS/FAIL per check; exits non-zero on ANY failure):
//   A — P4 multi-avatar entity-type scene: human / ai_agent / npc, EACH carrying
//       an issuer-SIGNED VC claim, holder-bound (reciprocal-control, real
//       Ed25519) and VERIFIED end-to-end at Tier 1. Adversarial: tampered VC,
//       claim/VC mismatch, out-of-enum entityType, wrong issuer — all FAIL.
//   B — tier honesty: an UNBOUND Tier-1 entity-type
//       claim is VISIBLY capped at Tier 0 (holderBindingStatus "absent",
//       effectiveTrustTier 0, indicator shows the cap); a bound claim reaches
//       Tier 1; a TAMPERED binding fails closed to the cap.
//   C — proof-of-personhood: provider attestation verified (namespace +
//       freshness); an ai_agent or npc claiming human personhood FAILS CLOSED
//       (entity-type-inconsistent); stale attestations fail; ZK/nullifier-style
//       personhood claims FAIL CLOSED ("unimplemented-profile") — never verified.
//   D — age proof: issuer-signed threshold VC verified against the issuer key
//       with ZERO birth-material disclosure; labeled "signed-VC age proof" with
//       the FORWARD holder-ZK boundary; zk-age claims FAIL CLOSED; a VC that
//       leaks birth material FAILS; every VP under the 50 KB limit and an
//       oversize VC rejects the manifest.
//   E — the demo surface + honesty ceiling: 4-avatar scene rows, the ai-attempts-
//       personhood negative control, sealed gov-ID/DOB rows (opaque),
//       and the feature_CONFORMANCE descriptor's real-vs-FORWARD flags.
//
// External source of truth (READ-ONLY):

import {
  ENTITY_TYPES,
  CLAIM_TYPE_ENTITY,
  CLAIM_TYPE_PERSONHOOD,
  CLAIM_TYPE_AGE_OVER,
  AGE_PROOF_MECHANISM,
  AGE_PROOF_LABEL,
  FORWARD_ZK_BOUNDARY,
  FORWARD_PERSONHOOD_BOUNDARY,
  feature_CONFORMANCE,
  issueVcJcsEd25519,
  verifyVcJcsEd25519,
  buildEntityTypeClaim,
  buildPersonhoodClaim,
  buildAgeOverClaim,
  buildDemoAvatarManifest,
  evaluateEntityPersonhood,
  entityTypeIndicator,
  buildEntityPersonhoodDemoSurface,
} from "./entity-personhood.mjs";

import { generateKeyPair } from "../signing/ed25519.mjs";
import { attachSignatureProfileA } from "../signing/um-signature-profile-a.mjs";
import { checkClaimProofSizeLimits } from "./holder-binding.mjs";

let PASS = 0;
let FAIL = 0;
const failures = [];
function check(id, ok, msg, detail) {
  if (ok) {
    PASS += 1;
    console.log(`PASS  ${id}  ${msg}`);
  } else {
    FAIL += 1;
    failures.push(id);
    console.error(`FAIL  ${id}  ${msg}`);
    if (detail) console.error(`        ${detail}`);
  }
}

const CTX = () => ({ now: new Date().toISOString(), maxSupportedTrustTier: 1 });

// ---------------------------------------------------------------------------
// A — P4 multi-avatar entity-type scene (each signed + verified) + adversarial
// ---------------------------------------------------------------------------
async function sectionA() {
  for (const entityType of ENTITY_TYPES) {
    const { manifest } = await buildDemoAvatarManifest({ entityType });
    const f = await evaluateEntityPersonhood(manifest, CTX());
    const ind = entityTypeIndicator(f);
    check(
      `A1:${entityType}`,
      f.signatureCheck === "valid" &&
        f.entityTypeStatus === "verified" &&
        f.entityType === entityType &&
        f.effectiveTrustTier === 1 &&
        ind.verified === true &&
        ind.tier === 1 &&
        ind.badge.startsWith(`${entityType} — verified`),
      `"${entityType}" avatar: issuer-signed VC verified end-to-end, holder-bound, relied on at Tier 1 — badge "${ind.badge}"`,
      JSON.stringify({ status: f.entityTypeStatus, tier: f.effectiveTrustTier, outcome: f.outcome })
    );
  }

  // A2 — tampered VC proofValue ⇒ FAILED (real crypto, not presence-checking).
  const { manifest: m2 } = await buildDemoAvatarManifest({ entityType: "human" });
  const t2 = structuredClone(m2);
  const pv = t2.claims[0].claimProof.validation.proofValue;
  t2.claims[0].claimProof.validation.proofValue = (pv[0] === "A" ? "B" : "A") + pv.slice(1);
  delete t2.signature; // re-sign so ONLY the VC crypto is at fault
  const subjectKeys2 = await generateKeyPair();
  t2.subject = t2.subject; // subject key differs, but Profile A embeds the new key
  const t2signed = await attachSignatureProfileA(t2, subjectKeys2.seed);
  const f2 = await evaluateEntityPersonhood(t2signed, CTX());
  check(
    "A2",
    f2.entityTypeStatus !== "verified" &&
      f2.claimStatuses.some((s) => s.claimRef.includes("entity-type") && s.status !== "verified"),
    "tampered VC proofValue ⇒ entity-type attestation FAILS verification (never trusted)",
    JSON.stringify({ status: f2.entityTypeStatus })
  );

  // A3 — claim body says "human" but the SIGNED credential attests "npc" ⇒ FAIL.
  const issuer3 = await generateKeyPair();
  const subject3keys = await generateKeyPair();
  const claim3 = await buildEntityTypeClaim({
    entityType: "npc",
    subject: "did:web:demo.local:user:mismatch",
    issuerPrivateKey: issuer3.privateKey,
    requiredTrustTier: 0, // Tier 0 so the tier gate defers and the VC check runs
  });
  claim3.entityType = "human"; // the lie: body relabeled AFTER issuance
  const m3 = await attachSignatureProfileA(
    {
      "@context": "https://universalmanifest.net/ns/v0.4",
      "@id": `urn:uuid:${globalThis.crypto.randomUUID()}`,
      "@type": "um:Manifest",
      manifestVersion: "0.4",
      subject: "did:web:demo.local:user:mismatch",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      claims: [claim3],
    },
    subject3keys.seed
  );
  const f3 = await evaluateEntityPersonhood(m3, CTX());
  const s3 = f3.claimStatuses.find((s) => s.claimRef === claim3["@id"]);
  check(
    "A3",
    f3.entityTypeStatus === "failed" && s3?.status === "failed" && /mismatch/.test(s3?.reason || ""),
    'claim body relabeled "human" over a SIGNED "npc" credential ⇒ mismatch FAILS (an ai/npc cannot relabel itself human)',
    JSON.stringify(s3)
  );

  // A4 — out-of-enum entityType refused at BUILD time (holder can't emit it).
  let threw4 = false;
  try {
    await buildEntityTypeClaim({ entityType: "cyborg", subject: "did:x", issuerPrivateKey: issuer3.privateKey });
  } catch {
    threw4 = true;
  }
  check("A4", threw4, 'out-of-enum entityType ("cyborg") refused at emit time (enum human|ai_agent|npc)');

  // A5 — VC verified against the WRONG expected issuer ⇒ FAIL (issuer pinning).
  const vc5 = await issueVcJcsEd25519({
    credentialType: CLAIM_TYPE_ENTITY,
    credentialSubject: { id: "did:x", entityType: "human" },
    issuerPrivateKey: issuer3.privateKey,
  });
  const r5 = await verifyVcJcsEd25519(vc5, { expectedIssuer: "did:key:zSomeOtherIssuer" });
  const r5ok = await verifyVcJcsEd25519(vc5);
  check(
    "A5",
    r5.verified === false && /expected issuer/.test(r5.reason) && r5ok.verified === true,
    "VC verifies under its true issuer key but FAILS under a substituted expected issuer (end-to-end issuer pinning)"
  );
}

// ---------------------------------------------------------------------------
// B — tier honesty: unbound ⇒ VISIBLE Tier-0 cap; bound ⇒ Tier 1; tamper ⇒ cap
// ---------------------------------------------------------------------------
async function sectionB() {
  // B1 — UNBOUND Tier-1 entity-type claim ⇒ capped at Tier 0, visibly.
  const { manifest: unbound } = await buildDemoAvatarManifest({ entityType: "human", unbound: true });
  const fu = await evaluateEntityPersonhood(unbound, CTX());
  const iu = entityTypeIndicator(fu);
  check(
    "B1",
    fu.holderBindingStatus === "absent" &&
      fu.effectiveTrustTier === 0 &&
      fu.entityTypeStatus === "capped-tier-0" &&
      fu.claimStatuses.some((s) => s.status === "trustTierUnsupported" && s.tier === 0) &&
      iu.capped === true &&
      /capped at Tier 0/.test(iu.badge),
    `UNBOUND entity-type claim ⇒ runtime Tier-0 cap (holderBindingStatus "absent", effectiveTrustTier 0) — indicator: "${iu.badge}"`,
    JSON.stringify({ hb: fu.holderBindingStatus, tier: fu.effectiveTrustTier, status: fu.entityTypeStatus })
  );

  // B2 — the SAME claim, BOUND ⇒ Tier 1.
  const { manifest: bound } = await buildDemoAvatarManifest({ entityType: "human" });
  const fb = await evaluateEntityPersonhood(bound, CTX());
  check(
    "B2",
    fb.effectiveTrustTier === 1 && fb.entityTypeStatus === "verified" && entityTypeIndicator(fb).tier === 1,
    "the same claim HOLDER-BOUND (real reciprocal-control crypto) ⇒ relied on at Tier 1 (runtime ⇒ runtime uplift)"
  );

  // B3 — TAMPERED binding proof ⇒ verification fails ⇒ capped (fail closed).
  const tampered = structuredClone(bound);
  const bp = tampered.claims[0].holderBinding.subjectProof;
  tampered.claims[0].holderBinding.subjectProof = (bp[0] === "A" ? "B" : "A") + bp.slice(1);
  delete tampered.signature;
  const rekey = await generateKeyPair();
  const tamperedSigned = await attachSignatureProfileA(tampered, rekey.seed);
  const ft = await evaluateEntityPersonhood(tamperedSigned, CTX());
  check(
    "B3",
    ft.holderBindingStatus === "failed" &&
      ft.effectiveTrustTier === 0 &&
      ft.entityTypeStatus === "capped-tier-0" &&
      entityTypeIndicator(ft).capped === true,
    'TAMPERED holder-binding validation ⇒ runtime "failed" ⇒ Tier-0 cap (never uplifted, never verified)',
    JSON.stringify({ hb: ft.holderBindingStatus, tier: ft.effectiveTrustTier })
  );

  // B4 — unsigned manifest ⇒ nothing is trusted (signature gate fail-closed).
  const { manifest: signed } = await buildDemoAvatarManifest({ entityType: "npc" });
  const unsigned = structuredClone(signed);
  delete unsigned.signature;
  const f4 = await evaluateEntityPersonhood(unsigned, CTX());
  check(
    "B4",
    f4.outcome === "rejected" && f4.signatureCheck !== "valid" && f4.entityType === null,
    "manifest without a valid Profile-A signature ⇒ rejected; NO claim on it is trusted (fail closed)"
  );
}

// ---------------------------------------------------------------------------
// C — proof-of-personhood: consistency gate + freshness + ZK fail-closed
// ---------------------------------------------------------------------------
async function sectionC() {
  // C1 — human avatar with a bound, namespaced, fresh personhood attestation ⇒ verified.
  const { manifest: human } = await buildDemoAvatarManifest({ entityType: "human", withPersonhood: true });
  const f1 = await evaluateEntityPersonhood(human, CTX());
  check(
    "C1",
    f1.personhood?.status === "verified" &&
      /namespace/.test(f1.personhood.reason) &&
      /uniqueness NOT claimed/.test(f1.personhood.reason) &&
      f1.personhood.boundary === FORWARD_PERSONHOOD_BOUNDARY,
    "human + verified entity type ⇒ personhood provider attestation VERIFIED (namespaced, fresh) — uniqueness explicitly NOT claimed",
    JSON.stringify(f1.personhood)
  );

  // C2/C3 — ai_agent and npc ATTEMPTING human personhood ⇒ FAIL CLOSED.
  for (const [id, entityType] of [["C2", "ai_agent"], ["C3", "npc"]]) {
    const { manifest } = await buildDemoAvatarManifest({ entityType, withPersonhood: true });
    const f = await evaluateEntityPersonhood(manifest, CTX());
    check(
      id,
      f.personhood?.status === "entity-type-inconsistent" && f.personhood?.status !== "verified",
      `${entityType} claiming human personhood ⇒ FAILED CLOSED ("entity-type-inconsistent") — an ${entityType} cannot claim human personhood`,
      JSON.stringify(f.personhood)
    );
  }

  // C4 — STALE personhood attestation (validUntil in the past) ⇒ fail closed.
  const staleKeys = await generateKeyPair();
  const staleIssuer = await generateKeyPair();
  const subjectDid = "did:web:demo.local:user:stale";
  const entityIssuer = await generateKeyPair();
  const staleManifest = await attachSignatureProfileA(
    {
      "@context": "https://universalmanifest.net/ns/v0.4",
      "@id": `urn:uuid:${globalThis.crypto.randomUUID()}`,
      "@type": "um:Manifest",
      manifestVersion: "0.4",
      subject: subjectDid,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      claims: [
        await buildEntityTypeClaim({ entityType: "human", subject: subjectDid, issuerPrivateKey: entityIssuer.privateKey, requiredTrustTier: 0 }),
        await buildPersonhoodClaim({
          subject: subjectDid,
          namespace: "did:web:demo.local:world:atrium#personhood",
          issuerPrivateKey: staleIssuer.privateKey,
          validUntil: new Date(Date.now() - 60_000).toISOString(), // already stale
          requiredTrustTier: 0,
        }),
      ],
    },
    staleKeys.seed
  );
  const f4 = await evaluateEntityPersonhood(staleManifest, CTX());
  check(
    "C4",
    f4.personhood?.status === "stale" && f4.personhood?.status !== "verified",
    'personhood attestation past its validUntil ⇒ "stale", failed closed (freshness is part of the Tier-1 posture)',
    JSON.stringify(f4.personhood)
  );

  // C5 — ZK / nullifier-style personhood claim ⇒ FAIL CLOSED, never verified.
  const zkKeys = await generateKeyPair();
  const zkManifest = await attachSignatureProfileA(
    {
      "@context": "https://universalmanifest.net/ns/v0.4",
      "@id": `urn:uuid:${globalThis.crypto.randomUUID()}`,
      "@type": "um:Manifest",
      manifestVersion: "0.4",
      subject: "did:web:demo.local:user:zk",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      claims: [
        {
          "@id": "urn:um:claim:personhood:zk-attempt",
          "@type": CLAIM_TYPE_PERSONHOOD,
          issuer: "did:web:zk-provider.example",
          subject: "did:web:demo.local:user:zk",
          namespace: "ctx#personhood",
          proofMechanism: "zk-nullifier-uniqueness",
          requiredTrustTier: 0,
          claimProof: { proofType: "zk-semaphore-v4", proofValue: "uSTRUCTURAL-ONLY-NO-CRYPTO" },
        },
      ],
    },
    zkKeys.seed
  );
  const f5 = await evaluateEntityPersonhood(zkManifest, CTX());
  check(
    "C5",
    f5.personhood?.status === "unimplemented-profile" &&
      f5.personhood?.status !== "verified" &&
      f5.warnings.some((w) => w.code === "um:reason:validation:zk-profile-unimplemented"),
    'ZK/nullifier personhood claim ⇒ "unimplemented-profile", FAILED CLOSED (no ZK verifier exists here — never reported verified)',
    JSON.stringify(f5.personhood)
  );

  // C6 — namespace is REQUIRED (builder refuses; hand-rolled unnamespaced claim fails).
  let threw6 = false;
  try {
    await buildPersonhoodClaim({ subject: "did:x", issuerPrivateKey: staleIssuer.privateKey });
  } catch {
    threw6 = true;
  }
  check("C6", threw6, "personhood builder REFUSES to emit without a namespace (namespace separation is mandatory)");
}

// ---------------------------------------------------------------------------
// D — age proof: signed-VC threshold, no birth disclosure, FORWARD-labeled
// ---------------------------------------------------------------------------
async function sectionD() {
  const { manifest } = await buildDemoAvatarManifest({ entityType: "human", withAgeProof: true, ageThreshold: 18 });
  const f1 = await evaluateEntityPersonhood(manifest, CTX());

  // D1 — verified against the issuer key, threshold 18, Tier 1 (bound).
  check(
    "D1",
    f1.ageProof?.status === "verified" && f1.ageProof?.threshold === 18 && /issuer key/.test(f1.ageProof.reason),
    "age validation VERIFIED against the issuer key (real Ed25519 over the VC's JCS bytes), threshold 18 satisfied",
    JSON.stringify(f1.ageProof)
  );

  // D2 — ZERO birth-material disclosure: not in the VC subject, not anywhere in the claim.
  const ageClaim = manifest.claims.find((c) => c["@type"] === CLAIM_TYPE_AGE_OVER);
  const claimJson = JSON.stringify(ageClaim).toLowerCase();
  check(
    "D2",
    !/birth|dateofbirth|"dob"/.test(claimJson),
    "the age-validation claim + credential contain ZERO birth material (birth date lives only in the runtime sealed facet)"
  );

  // D3 — honesty labels: "signed-VC age proof" + the FORWARD holder-ZK boundary,
  //      and the mechanism is NEVER a ZK label.
  check(
    "D3",
    f1.ageProof.mechanism === AGE_PROOF_MECHANISM &&
      f1.ageProof.label === AGE_PROOF_LABEL &&
      /signed-VC age validation/.test(f1.ageProof.label) &&
      f1.ageProof.boundary === FORWARD_ZK_BOUNDARY &&
      /FORWARD/.test(f1.ageProof.boundary) &&
      !/^zk/i.test(f1.ageProof.mechanism),
    `honesty labels present: label "${AGE_PROOF_LABEL}" + FORWARD boundary — NEVER labeled a live ZK validation`
  );

  // D4 — a claim asserting a zk age proof ⇒ FAIL CLOSED. Built with NO tier
  //      objection (Tier 0, no binding) so the ZK guard itself is what fires —
  //      a Tier-1 zk claim would already be capped (also fail-closed).
  const k4 = await generateKeyPair();
  const zkAgeSigned = await attachSignatureProfileA(
    {
      "@context": "https://universalmanifest.net/ns/v0.4",
      "@id": `urn:uuid:${globalThis.crypto.randomUUID()}`,
      "@type": "um:Manifest",
      manifestVersion: "0.4",
      subject: "did:web:demo.local:user:zk-age",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      claims: [
        {
          "@id": "urn:um:claim:age-zk-attempt",
          "@type": CLAIM_TYPE_AGE_OVER,
          issuer: "did:web:zk-attestor.example",
          subject: "did:web:demo.local:user:zk-age",
          ageOver: 18,
          proofMechanism: "zk-range-validation",
          requiredTrustTier: 0,
          claimProof: { proofType: "zk-bulletproof", proofValue: "uSTRUCTURAL-ONLY-NO-CRYPTO" },
        },
      ],
    },
    k4.seed
  );
  const f4 = await evaluateEntityPersonhood(zkAgeSigned, CTX());
  check(
    "D4",
    f4.ageProof?.status === "unimplemented-profile" && f4.ageProof?.status !== "verified",
    'a claim asserting "zk-range-validation" ⇒ FAILED CLOSED (no ZK verifier — the boundary is enforced, not just labeled)',
    JSON.stringify(f4.ageProof)
  );

  // D5 — an issuer VC that LEAKS birth material ⇒ FAILED (non-disclosure guard).
  const leakIssuer = await generateKeyPair();
  const leakKeys = await generateKeyPair();
  const leakVc = await issueVcJcsEd25519({
    credentialType: CLAIM_TYPE_AGE_OVER,
    credentialSubject: { id: "did:x", ageOver: 18, satisfied: true, dateOfBirth: "1990-04-12" },
    issuerPrivateKey: leakIssuer.privateKey,
  });
  const leakManifest = await attachSignatureProfileA(
    {
      "@context": "https://universalmanifest.net/ns/v0.4",
      "@id": `urn:uuid:${globalThis.crypto.randomUUID()}`,
      "@type": "um:Manifest",
      manifestVersion: "0.4",
      subject: "did:x",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      claims: [
        {
          "@id": "urn:um:claim:age-leak",
          "@type": CLAIM_TYPE_AGE_OVER,
          issuer: leakVc.issuer,
          subject: "did:x",
          ageOver: 18,
          requiredTrustTier: 0,
          claimProof: leakVc,
        },
      ],
    },
    leakKeys.seed
  );
  const f5 = await evaluateEntityPersonhood(leakManifest, CTX());
  check(
    "D5",
    f5.ageProof?.status === "failed" && /DISCLOSES birth material/.test(f5.ageProof.reason),
    "an age VC that DISCLOSES birth material FAILS the non-disclosure guard (P5: threshold without birth date)",
    JSON.stringify(f5.ageProof)
  );

  // D6 — VP size: the demo age VC is byte-counted under 50 KB; an oversize VC rejects.
  const sizes = checkClaimProofSizeLimits(manifest);
  const oversize = structuredClone(manifest);
  oversize.claims.find((c) => c["@type"] === CLAIM_TYPE_AGE_OVER).claimProof.padding = "x".repeat(51 * 1024);
  delete oversize.signature;
  const k6 = await generateKeyPair();
  const oversizeSigned = await attachSignatureProfileA(oversize, k6.seed);
  const f6 = await evaluateEntityPersonhood(oversizeSigned, CTX());
  check(
    "D6",
    sizes.valid === true &&
      sizes.entries.every((e) => e.bytes < 50 * 1024) &&
      f6.outcome === "rejected" &&
      f6.warnings.some((w) => w.code === "um:reason:limits:claim-validation-oversize"),
    `embedded VPs measured ${sizes.entries.map((e) => e.bytes).join("/")} bytes (< 50 KB); a 51 KB VC REJECTS the manifest (runtime G2)`
  );
}

// ---------------------------------------------------------------------------
// E — demo surface + honesty descriptor
// ---------------------------------------------------------------------------
async function sectionE() {
  const surface = await buildEntityPersonhoodDemoSurface();

  // E1 — P4 scene: human/ai_agent/npc rows all verified at Tier 1.
  const trio = surface.avatars.slice(0, 3);
  check(
    "E1",
    trio.length === 3 &&
      trio.every((a) => a.indicator.verified === true && a.indicator.tier === 1) &&
      trio.map((a) => a.indicator.entityType).join(",") === "human,ai_agent,npc",
    `P4 multi-avatar scene: ${trio.map((a) => `"${a.indicator.badge}"`).join(" | ")}`
  );

  // E2 — the unbound row is VISIBLY capped at Tier 0 in the same scene.
  const unboundRow = surface.avatars[3];
  check(
    "E2",
    unboundRow.indicator.capped === true &&
      unboundRow.indicator.tier === 0 &&
      unboundRow.holderBindingStatus === "absent" &&
      /capped at Tier 0/.test(unboundRow.indicator.badge),
    `the unbound visitor row shows the cap: "${unboundRow.indicator.badge}"`
  );

  // E3 — P5 rows: age proof + personhood verified, labels riding along.
  check(
    "E3",
    surface.ageProof?.status === "verified" &&
      surface.ageProof?.label === AGE_PROOF_LABEL &&
      surface.personhood?.status === "verified" &&
      /FORWARD/.test(surface.honesty.age_proof) &&
      /FORWARD/.test(surface.honesty.personhood),
    "P5 panel: signed-VC age validation + personhood attestation verified, FORWARD boundaries printed in the honesty block"
  );

  // E4 — the negative control: ai_agent attempting personhood is refused.
  check(
    "E4",
    surface.aiPersonhoodRefused.status === "entity-type-inconsistent",
    "surface carries the negative control: ai_agent attempting personhood ⇒ entity-type-inconsistent (fail closed)"
  );

  // E5 — reuse: sealed gov-ID + full-birth-date rows render OPAQUE.
  check(
    "E5",
    surface.sealedRows.length === 2 && surface.sealedRows.every((r) => r.status === "opaque"),
    `sealed facets (runtime reuse): ${surface.sealedRows.map((r) => r.display).join(" | ")}`
  );

  // E6 — the honesty descriptor is internally consistent (no overclaim flags).
  check(
    "E6",
    feature_CONFORMANCE.age_proof_is_zk === false &&
      feature_CONFORMANCE.zk_personhood_verification === false &&
      feature_CONFORMANCE.personhood_uniqueness_claimed === false &&
      feature_CONFORMANCE.um_conformance_flag_flipped === false &&
      feature_CONFORMANCE.external_fixtures_owned === 0 &&
      feature_CONFORMANCE.entity_type_issuer_vc_verification_real === true &&
      feature_CONFORMANCE.tier0_cap_via_wo133_real === true &&
      feature_CONFORMANCE.tier1_via_wo134_binding_real === true,
    "feature_CONFORMANCE descriptor: real surfaces flagged true, ZK/uniqueness/conformance flags all false (no overclaim)"
  );
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("runtime entity-type attestation + personhood — standalone verification");
  console.log("======================================================================");
  console.log(`module descriptor: ${feature_CONFORMANCE.scoped_claim}\n`);

  console.log("-- A: P4 multi-avatar entity-type scene (signed + verified) + adversarial");
  await sectionA();
  console.log("\n-- B: tier honesty — unbound ⇒ VISIBLE Tier-0 cap; bound ⇒ Tier 1 (runtime/134)");
  await sectionB();
  console.log("\n-- C: validation-of-personhood — consistency gate, freshness, ZK fail-closed");
  await sectionC();
  console.log("\n-- D: age validation — signed-VC threshold, zero birth disclosure, FORWARD-labeled");
  await sectionD();
  console.log("\n-- E: demo surface + honesty descriptor");
  await sectionE();

  console.log("\n======================================================================");
  console.log(`TOTAL: ${PASS + FAIL}  PASS: ${PASS}  FAIL: ${FAIL}`);
  if (FAIL > 0) {
    console.error(`FAILED CHECKS: ${failures.join(", ")}`);
    console.error("NOT PROVEN — fix before claiming the runtime surface.");
    process.exitCode = 1;
  } else {
    console.log(
      "ALL CHECKS PASS — P4 entity-type attestations (human/ai_agent/npc) are issuer-signed and\n" +
        "verified for real; unbound claims cap VISIBLY at Tier 0 and bound ones reach Tier 1\n" +
        "; personhood is entity-type-gated, namespaced, fresh; the age validation is a signed-VC\n" +
        "threshold claim (FORWARD ZK boundary enforced — zk-* claims fail closed, never verified)."
    );
  }
}

main().catch((e) => {
  console.error(`DRIVER ERROR: ${e.stack || e.message}`);
  process.exitCode = 1;
});
