#!/usr/bin/env node
// ADVERSARIAL HARDENING HARNESS (additive; the module under
// test is NOT modified). Companion to verify.mjs: where the verifier proves
// the HAPPY-PATH tamper probes break verification, THIS harness tries to DEFEAT
// them — to accept a tampered / truncated / re-forged chain, collide an
// exchangeId, or violate an invariant.
//
//   node web/manifest/attack-vectors.mjs      (any cwd; paths are absolute)
//
// Each vector prints one of:
//   RESISTED     — the attack was detected / rejected (the defence held).
//   ⚠️VULNERABLE — the attack SUCCEEDED (real finding; reproduction printed).
//   NOTE         — defence-in-depth observation / declared boundary (not counted
//                  as a chain break, but worth a follow-up fix task's attention).
//
// process.exitCode = number of ⚠️VULNERABLE chain-integrity breaks (0 = SOUND).
// LOW-severity lint/boundary findings are reported but do NOT gate the exit code.
//
// HONESTY: declared PREVIEW deltas (house sha256:hex vs multibase, genesis null vs
// omitted, sessionKeyAuthorization unimplemented) are NOT treated as vulnerabilities.
// Only real classes are flagged: (a) chain tamper not detected, (b) splice/reorder/
// truncate/replay accepted, (c) exchangeId collision / correlation error, (d) an
// invariant violated, (e) a hash-convention exploit.
//
// External source of truth (READ-ONLY):
//   spec/v0.4/CONFORMANCE.md §4 (bilateral / receipt chain); EXT-OPT O3.1/O4.

import {
  createBilateralSession,
  advanceSessionState,
  pairSessionReceipts,
  createReceiptHashChain,
  appendReceiptToChain,
  sealReceiptHashChain,
  verifyReceiptChain,
  verifyChainSealFields,
  fillChainSealFields,
  lintCorrelationToken,
  correlateReceiptPair,
  mintExchangeId,
  conductBilateralExchange,
} from "./bilateral-chain.mjs";
import {
  createReceipt,
  mergeFragment,
  finalizeReceipt,
  validateReceiptShape,
  correlateDualReceipts,
  buildReceiptChainFacet,
  createReceiptChain,
  appendChainEvent,
  sealReceiptChain,
} from "./receipt-hub.mjs";
import { canonicalManifestHash } from "./projection.mjs";
import { attachSignatureProfileA, verifyManifestProfileA } from "../signing/um-signature-profile-a.mjs";
import { generateKeyPair, derivePublicKeyRaw } from "../signing/ed25519.mjs";
import { publicKeyToDidKey } from "../signing/did.mjs";
import { UM_V04_CONTEXT, UM_V04_MANIFEST_VERSION } from "./interfaces.mjs";

const NOW = "2026-06-15T00:00:00.000Z";

// ---------------------------------------------------------------------------
// result harness
// ---------------------------------------------------------------------------
let CHAIN_BREAKS = 0; // real, chain-integrity-breaking vulnerabilities (gate exit)
let LOW = 0; // low-severity lint/boundary findings (reported, not gated)
let RESISTED = 0;
const findings = [];

function resisted(id, desc, detail) {
  RESISTED += 1;
  console.log(`RESISTED     ${id}  ${desc}`);
  if (detail) console.log(`               ${detail}`);
}
function vulnerable(id, sev, desc, repro) {
  if (sev === "LOW") LOW += 1;
  else CHAIN_BREAKS += 1;
  findings.push({ id, sev, desc, repro });
  console.log(`⚠️VULNERABLE  ${id}  [${sev}]  ${desc}`);
  console.log(`               repro: ${repro}`);
}
function note(id, desc, detail) {
  findings.push({ id, sev: "NOTE", desc, repro: detail });
  console.log(`NOTE         ${id}  ${desc}`);
  if (detail) console.log(`               ${detail}`);
}

// ---------------------------------------------------------------------------
// fresh party (real Ed25519 keys, did:key identity, signed v0.4 manifest)
// ---------------------------------------------------------------------------
async function makeParty({ tier } = {}) {
  const kp = await generateKeyPair();
  const did = publicKeyToDidKey(await derivePublicKeyRaw(kp.privateKey));
  const manifest = await attachSignatureProfileA(
    {
      "@context": UM_V04_CONTEXT,
      "@id": `urn:uuid:${globalThis.crypto.randomUUID()}`,
      "@type": "um:Manifest",
      manifestVersion: UM_V04_MANIFEST_VERSION,
      subject: did,
      issuedAt: NOW,
      expiresAt: new Date(Date.parse(NOW) + 3600e3).toISOString(),
      ...(tier !== undefined ? { requiredTrustTier: tier } : {}),
    },
    kp.privateKey
  );
  return { did, manifest, privateKeyInput: kp.privateKey };
}
function makeEvaluator({ declaredEffectiveTier } = {}) {
  return async (manifest, { now }) => {
    const receipt = createReceipt({ manifestId: manifest["@id"] });
    const sig = await verifyManifestProfileA(manifest);
    receipt.signatureCheck = sig.ok ? "valid" : "invalid";
    const nowMs = Date.parse(now);
    receipt.freshnessCheck =
      Date.parse(manifest.issuedAt) > nowMs ? "stale" : Date.parse(manifest.expiresAt) < nowMs ? "expired" : "fresh";
    if (Number.isInteger(declaredEffectiveTier)) mergeFragment(receipt, { effectiveTrustTier: declaredEffectiveTier });
    return finalizeReceipt(receipt, { rejected: !sig.ok || receipt.freshnessCheck !== "fresh", now });
  };
}

// Build a GENUINE, sealed 3-link bilateral chain the same way the module does.
async function buildGenuineChain() {
  const VISITOR = await makeParty();
  const WORLD = await makeParty({ tier: 1 });
  const session = createBilateralSession({ initiatorDid: VISITOR.did, responderDid: WORLD.did, initiatedAt: NOW, ttlSeconds: 3600 });
  advanceSessionState(session, "manifests-exchanged", { now: NOW });
  const rA = await makeEvaluator({ declaredEffectiveTier: 1 })(WORLD.manifest, { now: NOW });
  const rB = await makeEvaluator({ declaredEffectiveTier: 1 })(VISITOR.manifest, { now: NOW });
  pairSessionReceipts(session, rA, rB, { now: NOW });

  // third link: a second world-side evaluation receipt (any canonical receipt works).
  const rC = createReceipt({ manifestId: VISITOR.manifest["@id"] });
  mergeFragment(rC, { effectiveTrustTier: 1 });
  finalizeReceipt(rC, { now: NOW });
  rC.exchangeId = session.exchangeId;
  rC.evaluatorId = WORLD.did;

  const chain = createReceiptHashChain(session);
  await appendReceiptToChain(chain, rA, { envelope: { subject: VISITOR.did, issuedAt: NOW }, privateKeyInput: VISITOR.privateKeyInput });
  await appendReceiptToChain(chain, rB, { envelope: { subject: WORLD.did, issuedAt: NOW }, privateKeyInput: WORLD.privateKeyInput });
  await appendReceiptToChain(chain, rC, { envelope: { subject: WORLD.did, issuedAt: NOW }, privateKeyInput: WORLD.privateKeyInput });
  advanceSessionState(session, "completed", { now: NOW });
  await sealReceiptHashChain(chain, { at: NOW });
  return { session, chain, VISITOR, WORLD };
}

// ===========================================================================
// SECTION 1 — SANITY: the known defences must hold (else the harness is lying)
// ===========================================================================
async function sanity(G) {
  const ok = await verifyReceiptChain(G.chain, { expectChainId: G.session.sessionId });
  if (ok.valid && ok.brokenAt === null && ok.length === 3) {
    resisted("S0", "genuine sealed 3-link chain verifies end-to-end (control)");
  } else {
    vulnerable("S0", "HIGH", "control chain failed to verify — harness setup is broken", JSON.stringify(ok.errors));
  }

  // mid-chain content mutate (mirror of verify F1) — must be caught.
  const t = structuredClone(G.chain.links);
  t[1].outcome = t[1].outcome === "accepted" ? "rejected" : "accepted";
  const r = await verifyReceiptChain(t, { expectChainId: G.session.sessionId });
  if (!r.valid && r.brokenAt === 1) resisted("S1", "mid-chain outcome mutate detected (own-signature break)");
  else vulnerable("S1", "HIGH", "mid-chain content mutate NOT detected", JSON.stringify(r));

  // single re-signed forged link, successor LEFT GENUINE (the F4 'money check').
  const t2 = structuredClone(G.chain.links);
  const { signature: _d, ...stripped } = t2[1];
  stripped.outcome = "accepted-with-warnings";
  const atk = await generateKeyPair();
  t2[1] = await attachSignatureProfileA(stripped, atk.privateKey);
  const forgedSig = await verifyManifestProfileA(t2[1]);
  const r2 = await verifyReceiptChain(t2, { expectChainId: G.session.sessionId });
  if (forgedSig.ok && !r2.valid && r2.brokenAt === 2) {
    resisted("S2", "single re-signed forged link caught by successor prevHash (F4 holds)");
  } else {
    vulnerable("S2", "HIGH", "F4 money-check does not hold in this build", JSON.stringify(r2));
  }
}

// ===========================================================================
// SECTION 2 — TRUNCATION / SEAL-ANCHOR ATTACKS (class b)
// ===========================================================================
async function truncation(G) {
  // AV1 — drop the TAIL of a SEALED chain. The seal object still says headSeq=2 /
  // headHash=hash(l2); verifyReceiptChain extracts ONLY chain.links and never
  // consults chain.sealed/headSeq/headHash.
  const clone = structuredClone(G.chain); // full sealed object (sealed,headSeq,headHash,links)
  const droppedHash = await canonicalManifestHash(clone.links[2]);
  clone.links.pop(); // truncate: remove link 2, keep seal metadata untouched
  const r = await verifyReceiptChain(clone, { expectChainId: G.session.sessionId });
  const sealSaysThree = clone.sealed === true && clone.headSeq === 2 && clone.headHash === droppedHash;
  if (r.valid && r.length === 2 && sealSaysThree) {
    vulnerable(
      "AV1",
      "HIGH",
      "TAIL TRUNCATION of a SEALED chain accepted — verifyReceiptChain ignores the seal anchor (headSeq/headHash)",
      `sealed chain carried headSeq=${clone.headSeq} headHash=${clone.headHash.slice(0, 20)}… but after links.pop() verifyReceiptChain returned {valid:${r.valid}, length:${r.length}, brokenAt:${r.brokenAt}} — the dropped receipt is undetectable at the primary verifier`
    );
  } else {
    resisted("AV1", "tail truncation rejected", JSON.stringify({ valid: r.valid, brokenAt: r.brokenAt }));
  }

  // AV2 — truncate ALL the way to genesis-only. A 1-link prefix is still internally
  // consistent (seq 0, prevHash null) → accepted.
  const clone2 = structuredClone(G.chain);
  clone2.links = clone2.links.slice(0, 1);
  const r2 = await verifyReceiptChain(clone2, { expectChainId: G.session.sessionId });
  if (r2.valid && r2.length === 1) {
    vulnerable(
      "AV2",
      "HIGH",
      "chain truncated to GENESIS-ONLY still 'verifies' — a bilateral 2-party record collapses to one receipt undetected",
      `verifyReceiptChain(slice(0,1)) → {valid:${r2.valid}, length:1}; the responder's entire receipt was erased with no broken link`
    );
  } else {
    resisted("AV2", "genesis-only truncation rejected", JSON.stringify({ valid: r2.valid }));
  }

  // AV3 — does the SIGNED departure-facet seal catch what the raw verifier missed?
  // (Fairness probe: confirm the mitigation surface exists.)
  try {
    const evChain = createReceiptChain({ subject: G.VISITOR.did });
    appendChainEvent(evChain, { eventClass: "departure", subject: G.VISITOR.did, reason: "session-completed" });
    sealReceiptChain(evChain, { at: NOW });
    const facet = buildReceiptChainFacet(evChain);
    await fillChainSealFields(facet, G.chain, { privateKeyInput: G.VISITOR.privateKeyInput }); // seals against the FULL 3-link chain
    const truncated = structuredClone(G.chain);
    truncated.links.pop(); // now 2 links
    const sealCheck = await verifyChainSealFields(facet, truncated);
    if (!sealCheck.ok) {
      note(
        "AV3",
        "the SIGNED departure-facet seal DOES catch truncation (mitigation exists) — but the live crossing path uses verifyReceiptChain, not this",
        `verifyChainSealFields(facet, truncatedChain).ok=false: ${sealCheck.errors.join("; ")}`
      );
    } else {
      vulnerable("AV3", "HIGH", "even the signed departure seal missed truncation", JSON.stringify(sealCheck));
    }
  } catch (e) {
    note("AV3", "departure-seal mitigation probe threw (informational)", e.message);
  }
}

// ===========================================================================
// SECTION 3 — RE-SIGN THE WHOLE TAIL UNDER THE VICTIM'S IDENTITY (class a) —
//   the attempt to DEFEAT F4: re-sign a forged link AND forge every successor's
//   prevHash consistently.
// ===========================================================================
async function wholeTailResign(G) {
  const links = structuredClone(G.chain.links);
  const victimEval1 = links[1].evaluatorId;
  const victimEval2 = links[2].evaluatorId;

  // Attacker owns ONE keypair (any key — the verifier trusts the key EMBEDDED in
  // each link; it never binds that key to the link's evaluatorId/subject).
  const attacker = await generateKeyPair();
  const attackerDid = publicKeyToDidKey(await derivePublicKeyRaw(attacker.privateKey));

  // Forge link 1's content (flip the recorded tier 1 → 0: a downgrade a relying
  // party would act on), KEEP evaluatorId/subject/chainId = victim, re-sign w/ attacker key.
  const { signature: _s1, ...body1 } = links[1];
  body1.effectiveTrustTier = 0; // forged downgrade
  const forged1 = await attachSignatureProfileA(body1, attacker.privateKey);

  // Fix up link 2's prevHash to chain onto the FORGED link 1, keep victim identity,
  // re-sign with the SAME attacker key.
  const { signature: _s2, ...body2 } = links[2];
  body2.prevHash = await canonicalManifestHash(forged1); // recompute successor linkage
  const forged2 = await attachSignatureProfileA(body2, attacker.privateKey);

  const forgedChain = [links[0], forged1, forged2];
  const r = await verifyReceiptChain(forgedChain, { expectChainId: G.session.sessionId });

  // Would a signing-key ↔ evaluatorId binding (offline-checkable for did:key) have caught it?
  const keyBindsToEvaluator = attackerDid === victimEval1; // false — attacker key ≠ victim DID
  if (r.valid && r.brokenAt === null && !keyBindsToEvaluator) {
    vulnerable(
      "AV4",
      "HIGH",
      "WHOLE-TAIL RE-SIGN under the victim's identity accepted — F4 DEFEATED: re-signing the forged link AND its successor makes the chain self-consistent again",
      `forged link1.effectiveTrustTier 1→0 + recomputed link2.prevHash, both re-signed with attacker did:key ${attackerDid.slice(0, 24)}…; ` +
        `links still claim evaluatorId=${String(victimEval1).slice(0, 28)}…/${String(victimEval2).slice(0, 12)}…; ` +
        `verifyReceiptChain → {valid:true} because it verifies each link against its OWN embedded key and never checks that key against evaluatorId/subject (a did:key binding is offline-derivable and would have caught this)`
    );
  } else {
    resisted("AV4", "whole-tail re-sign rejected", JSON.stringify({ valid: r.valid, brokenAt: r.brokenAt }));
  }

  // AV5 — same attack but ALSO relabel the identity to the attacker (honest variant):
  // proves the forged chain is a wholly valid chain of the attacker's own making,
  // i.e. verifyReceiptChain cannot distinguish "the session's chain" from "any
  // self-consistent chain bearing this chainId".
  const links2 = structuredClone(G.chain.links);
  const { signature: _a, ...b1 } = links2[1];
  b1.evaluatorId = attackerDid;
  b1.subject = attackerDid;
  b1.effectiveTrustTier = 0;
  const f1 = await attachSignatureProfileA(b1, attacker.privateKey);
  const { signature: _b, ...b2 } = links2[2];
  b2.evaluatorId = attackerDid;
  b2.subject = attackerDid;
  b2.prevHash = await canonicalManifestHash(f1);
  const f2 = await attachSignatureProfileA(b2, attacker.privateKey);
  const r5 = await verifyReceiptChain([links2[0], f1, f2], { expectChainId: G.session.sessionId });
  if (r5.valid) {
    note(
      "AV5",
      "a chain whose links are re-issued under the ATTACKER's own DID also verifies (chainId=sessionId is not secret — both parties + any MITM know it)",
      "expectChainId gives NO protection here: the attacker keeps chainId=sessionId (public), so the pin matches"
    );
  } else {
    resisted("AV5", "attacker-identity re-issue rejected", JSON.stringify({ valid: r5.valid }));
  }
}

// ===========================================================================
// SECTION 4 — SPLICE / REORDER / REPLAY / GENESIS-FORGERY (class b)
// ===========================================================================
async function spliceReorderReplay(G) {
  // AV6 — splice a link from a DIFFERENT chain (different chainId).
  const other = await buildGenuineChain();
  const spliced = structuredClone(G.chain.links);
  spliced[2] = structuredClone(other.chain.links[1]); // foreign link, foreign chainId, seq mismatch
  const r6 = await verifyReceiptChain(spliced, { expectChainId: G.session.sessionId });
  if (!r6.valid && r6.brokenAt === 2) resisted("AV6", "foreign-chain splice detected (chainId + prevHash break)");
  else vulnerable("AV6", "HIGH", "foreign-chain splice accepted", JSON.stringify(r6));

  // AV7 — swap two links (reorder).
  const reordered = structuredClone(G.chain.links);
  [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  const r7 = await verifyReceiptChain(reordered, { expectChainId: G.session.sessionId });
  if (!r7.valid) resisted("AV7", "link reorder/swap detected (seq + prevHash break)", `brokenAt ${r7.brokenAt}`);
  else vulnerable("AV7", "HIGH", "link reorder accepted", JSON.stringify(r7));

  // AV8 — replay/duplicate the last link (append a copy).
  const replay = structuredClone(G.chain.links);
  replay.push(structuredClone(replay[2])); // duplicate at index 3, seq stays 2
  const r8 = await verifyReceiptChain(replay, { expectChainId: G.session.sessionId });
  if (!r8.valid && r8.brokenAt === 3) resisted("AV8", "link replay/duplicate detected (seq 2 at index 3)");
  else vulnerable("AV8", "HIGH", "link replay accepted", JSON.stringify(r8));

  // AV9 — mid-chain genesis forgery: set link 1's prevHash = null (fake a new genesis).
  const genForge = structuredClone(G.chain.links);
  genForge[1].prevHash = null;
  const r9 = await verifyReceiptChain(genForge, { expectChainId: G.session.sessionId });
  if (!r9.valid && r9.brokenAt === 1) resisted("AV9", "mid-chain fake-genesis (prevHash:null at seq 1) detected");
  else vulnerable("AV9", "HIGH", "mid-chain fake-genesis accepted", JSON.stringify(r9));

  // AV10 — seq gap (renumber link 2 → 5).
  const seqGap = structuredClone(G.chain.links);
  seqGap[2].seq = 5;
  const r10 = await verifyReceiptChain(seqGap, { expectChainId: G.session.sessionId });
  if (!r10.valid && r10.brokenAt === 2) resisted("AV10", "seq gap (2→5) detected (breaks its own signature + monotonicity)");
  else vulnerable("AV10", "HIGH", "seq gap accepted", JSON.stringify(r10));
}

// ===========================================================================
// SECTION 5 — HASH-CONVENTION CONFUSION (class e): the chain hashes whole-doc
//   INCL signature; the signature EXCLUDES {signature, presentationProof,
//   postQuantumSignature}. Can a change verify-clean yet not re-hash?
// ===========================================================================
async function hashConvention(G) {
  // AV11 — inject presentationProof into a MID link. It is excluded from the
  // signing input (sig still verifies) BUT included in canonicalManifestHash, so
  // the SUCCESSOR's prevHash recompute must break. (Proves the whole-doc hash
  // convention PROTECTS the excluded fields for non-terminal links.)
  const mid = structuredClone(G.chain.links);
  mid[1].presentationProof = { proofType: "did-auth", challenge: "x", audience: "y", created: NOW, proofValue: "z" };
  const midSig = await verifyManifestProfileA(mid[1]);
  const r11 = await verifyReceiptChain(mid, { expectChainId: G.session.sessionId });
  if (midSig.ok && !r11.valid && r11.brokenAt === 2) {
    resisted("AV11", "presentationProof injected into a MID link: sig still verifies but successor prevHash catches the whole-doc hash change");
  } else {
    vulnerable("AV11", "HIGH", "mid-link excluded-field injection not caught", JSON.stringify(r11));
  }

  // AV12 — inject presentationProof into the TERMINAL link. No successor to
  // recompute its hash; verifyReceiptChain does not check the seal headHash.
  const tail = structuredClone(G.chain.links);
  tail[2].presentationProof = { proofType: "did-auth", challenge: "x", audience: "y", created: NOW, proofValue: "z" };
  const tailSig = await verifyManifestProfileA(tail[2]);
  const shapeOk = validateReceiptShape(tail[2]).valid;
  const r12 = await verifyReceiptChain(tail, { expectChainId: G.session.sessionId });
  if (r12.valid && tailSig.ok) {
    note(
      "AV12",
      "TERMINAL-link excluded-field injection (presentationProof / postQuantumSignature) is accepted by verifyReceiptChain",
      `sig still valid (field excluded from signing input), shapeValid=${shapeOk}, and no successor + no seal-headHash check ⇒ verifyReceiptChain stays valid. ` +
        `NON-SEMANTIC payload (these members carry no receipt meaning; outcome/tier/evaluatorId are all inside the signing input), so not an independent content forgery — but it is the SAME root cause as AV1/AV2: the terminal link is only anchored by the (unconsulted) seal headHash`
    );
  } else {
    resisted("AV12", "terminal-link excluded-field injection rejected", JSON.stringify({ valid: r12.valid }));
  }
}

// ===========================================================================
// SECTION 6 — EXCHANGE-ID / CORRELATION (class c)
// ===========================================================================
async function exchangeCorrelation(G) {
  // AV13 — entropy-lint bypass: a fully PREDICTABLE, counter-like exchangeId that
  // nonetheless passes lintCorrelationToken (shape + ≥128-bit + diversity + runs).
  const predictable = "urn:um:exchange:0123456789abcdef0123456789abcdef"; // 32 hex, 16 distinct nibbles, max run 1
  const lint = lintCorrelationToken(predictable, { kind: "exchange" });
  if (lint.ok) {
    vulnerable(
      "AV13",
      "LOW",
      "entropy-lint BYPASS: a fully predictable counter-like exchangeId passes as '≥128-bit crypto-random'",
      `lintCorrelationToken("${predictable}").ok=true — 16 distinct nibbles defeats the diversity heuristic and the sequential pattern has no long run; the lint's own goal of 'catches counters' is not met. ` +
        `(Module self-labels this a LINT, not an entropy validation — so LOW, but an attacker-chosen exchangeId that passes lets correlation tokens be guessed/pre-seeded.)`
    );
  } else {
    resisted("AV13", "predictable sequential exchangeId rejected by lint", lint.problems.join("; "));
  }

  // AV14 — exchangeId reuse across two independent sessions (using the predictable
  // token above). Does correlation return a WRONG pair, or fail safe?
  const p1 = await makeParty();
  const p2 = await makeParty();
  const p3 = await makeParty();
  const p4 = await makeParty();
  const s1 = correlateDualReceipts(
    Object.assign(createReceipt({ manifestId: "urn:x:s1a" }), { evaluatorId: p1.did }),
    Object.assign(createReceipt({ manifestId: "urn:x:s1b" }), { evaluatorId: p2.did }),
    { exchangeId: predictable, evaluatorIdA: p1.did, evaluatorIdB: p2.did }
  );
  const s2 = correlateDualReceipts(
    Object.assign(createReceipt({ manifestId: "urn:x:s2a" }), { evaluatorId: p3.did }),
    Object.assign(createReceipt({ manifestId: "urn:x:s2b" }), { evaluatorId: p4.did }),
    { exchangeId: predictable, evaluatorIdA: p3.did, evaluatorIdB: p4.did }
  );
  const pile = [...s1.receipts, ...s2.receipts]; // 4 receipts, ONE shared exchangeId
  const found = correlateReceiptPair(pile, predictable);
  if (!found.ok && found.found === 4) {
    resisted("AV14", "exchangeId reuse across sessions FAILS SAFE at correlation (4 matches ≠ 2 ⇒ not ok)");
  } else {
    vulnerable("AV14", "HIGH", "exchangeId reuse yields a confident pair", JSON.stringify(found));
  }

  // AV15 — targeted correlation confusion: replace one genuine receipt of a pair
  // with a FORGED one bearing the same exchangeId + a distinct evaluatorId. The
  // retrieval primitive trusts the fields; it does not verify signatures.
  const genuinePair = correlateDualReceipts(
    Object.assign(createReceipt({ manifestId: "urn:x:g1" }), { evaluatorId: p1.did }),
    Object.assign(createReceipt({ manifestId: "urn:x:g2" }), { evaluatorId: p2.did }),
    { exchangeId: mintExchangeId(), evaluatorIdA: p1.did, evaluatorIdB: p2.did }
  );
  const forgedReceipt = Object.assign(createReceipt({ manifestId: "urn:x:forged" }), {
    evaluatorId: "did:example:attacker",
    exchangeId: genuinePair.exchangeId,
  });
  const pileWithForgery = [genuinePair.receipts[0], forgedReceipt]; // genuine + forged, share exchangeId
  const found2 = correlateReceiptPair(pileWithForgery, genuinePair.exchangeId);
  if (found2.ok && found2.pair.includes(forgedReceipt)) {
    note(
      "AV15",
      "correlateReceiptPair returns a pair containing an UNVERIFIED forged receipt (retrieval primitive trusts exchangeId/evaluatorId; it does not verify signatures)",
      "by design a retrieval helper (the caller must verify each receipt's signature), but callers must not treat 'ok:true' as authentication — a substituted receipt with the right fields correlates clean"
    );
  } else {
    resisted("AV15", "forged-receipt correlation rejected", JSON.stringify({ ok: found2.ok }));
  }
}

// ===========================================================================
// SECTION 7 — INVARIANTS: append-after-seal + pre-signed input (class d)
// ===========================================================================
async function invariants(G) {
  // AV16 — append after seal must throw.
  let threw16 = false;
  try {
    await appendReceiptToChain(G.chain, createReceipt({ manifestId: "urn:x:late" }), {
      envelope: { subject: G.WORLD.did },
      privateKeyInput: G.WORLD.privateKeyInput,
    });
  } catch (e) {
    threw16 = /sealed/.test(e.message);
  }
  if (threw16) resisted("AV16", "append-after-seal throws (flushPolicy session-end)");
  else vulnerable("AV16", "HIGH", "append-after-seal did NOT throw", "a sealed chain accepted a new link");

  // AV17 — pre-signed receipt-manifest input must throw (chain fields must sit
  // inside the signed payload, so the input must be UNSIGNED).
  const fresh = await buildGenuineChain();
  const preSigned = structuredClone(fresh.chain.links[0]); // an ALREADY-signed receipt manifest
  let threw17 = false;
  let reason17 = "";
  try {
    await appendReceiptToChain(fresh.chain, preSigned, { envelope: { subject: fresh.WORLD.did }, privateKeyInput: fresh.WORLD.privateKeyInput });
  } catch (e) {
    reason17 = e.message;
    threw17 = /already signed|sealed/.test(e.message);
  }
  // fresh.chain is sealed, so it may throw "sealed" first; rebuild an UNSEALED chain to isolate the pre-signed guard.
  const openParty = await makeParty();
  const openSession = createBilateralSession({ initiatorDid: openParty.did, responderDid: fresh.WORLD.did, initiatedAt: NOW, ttlSeconds: 3600 });
  const openChain = createReceiptHashChain(openSession);
  const seed = createReceipt({ manifestId: "urn:x:seed" });
  mergeFragment(seed, { effectiveTrustTier: 1 });
  finalizeReceipt(seed, { now: NOW });
  const signedSeed = await appendReceiptToChain(openChain, seed, { envelope: { subject: openParty.did, issuedAt: NOW }, privateKeyInput: openParty.privateKeyInput });
  let threw17b = false;
  try {
    await appendReceiptToChain(openChain, structuredClone(signedSeed), { envelope: { subject: openParty.did }, privateKeyInput: openParty.privateKeyInput });
  } catch (e) {
    reason17 = e.message;
    threw17b = /already signed/.test(e.message);
  }
  if (threw17b) resisted("AV17", "pre-signed receipt-manifest input throws (chain fields must be inside the signed payload)", reason17);
  else vulnerable("AV17", "HIGH", "pre-signed input accepted into the chain", reason17 || "no throw");
}

// ===========================================================================
async function main() {
  console.log("runtime receipt hash-chain — ADVERSARIAL HARDENING HARNESS");
  console.log("=========================================================");
  console.log("Trying to DEFEAT the chain: tamper, truncate, splice, re-forge, collide, violate invariants.\n");

  const G = await buildGenuineChain();

  console.log("-- SANITY: known defences must hold");
  await sanity(G);
  console.log("\n-- CLASS b: truncation / seal-anchor");
  await truncation(G);
  console.log("\n-- CLASS a: whole-tail re-sign under victim identity (defeat F4)");
  await wholeTailResign(G);
  console.log("\n-- CLASS b: splice / reorder / replay / genesis-forgery / seq");
  await spliceReorderReplay(G);
  console.log("\n-- CLASS e: hash-convention confusion (whole-doc INCL sig vs JCS exclusion)");
  await hashConvention(G);
  console.log("\n-- CLASS c: exchangeId entropy-lint / reuse / correlation");
  await exchangeCorrelation(G);
  console.log("\n-- CLASS d: invariants (append-after-seal, pre-signed input)");
  await invariants(G);

  console.log("\n=========================================================");
  console.log(`RESISTED: ${RESISTED}   ⚠️VULNERABLE (chain-break): ${CHAIN_BREAKS}   LOW/lint: ${LOW}`);
  if (CHAIN_BREAKS === 0) {
    console.log("\nVERDICT: no chain-integrity break found in the raw attack set beyond the reported items.");
  } else {
    console.log("\nVERDICT: CHAIN-INTEGRITY VULNERABILITIES FOUND (ranked, with reproductions):");
    for (const f of findings.filter((x) => x.sev !== "NOTE" && x.sev !== "LOW")) {
      console.log(`  [${f.sev}] ${f.id}  ${f.desc}`);
    }
  }
  const lows = findings.filter((x) => x.sev === "LOW");
  if (lows.length) {
    console.log("\nLOW-severity findings:");
    for (const f of lows) console.log(`  [LOW] ${f.id}  ${f.desc}`);
  }
  const notes = findings.filter((x) => x.sev === "NOTE");
  if (notes.length) {
    console.log("\nNOTES (defence-in-depth / declared boundary):");
    for (const f of notes) console.log(`  ${f.id}  ${f.desc}`);
  }
  console.log(`\nEXIT CODE = ${CHAIN_BREAKS} (count of chain-integrity breaks; 0 = SOUND). A follow-up fix should drive this to 0.`);
  process.exitCode = CHAIN_BREAKS;
}

main().catch((e) => {
  console.error(`HARNESS ERROR: ${e.stack || e.message}`);
  process.exitCode = 255;
});
