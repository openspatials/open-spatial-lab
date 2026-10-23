#!/usr/bin/env node
// ADVERSARIAL attack-vector harness for the receipt-hub
// composition (additive; READ-ONLY use of the module under test). This file
// MODIFIES NOTHING in receipt-hub.mjs — it only imports its public API and
// tries to BREAK the merge / compose / finalize / emit pipeline so that a
// REJECTED or DENIED evaluation silently becomes accepted.
//
//   node web/manifest/attack-vectors.mjs
//
// Each vector states a SECURITY EXPECTATION and prints one of:
//   RESISTED               — the hub enforced the expectation (attack failed)
//   ⚠️  VULNERABLE (sev)    — the hub accepted the attack (finding + reproduction)
//   NOTE                   — latent / by-design observation, not a standing finding
//
// Exit code: 0 when every hard vector RESISTS; 1 when any real finding stands;
// 2 on harness error. (Exit 1 is EXPECTED here — real findings were located.)
//
// Attack classes (per the hardening brief; the composition merges fragments from
// every other module, so a merge bug can let a rejected result read as accepted):
//   (a) rejected verdict LOST in the merge
//   (b) denied facet status OVERRIDDEN by the overridable `processed` baseline
//   (c) failure-dominant roll-up (holderBinding / presentationProof / tier) broken
//   (d) composeOutcome mapping bypass to a MORE-ACCEPTING result
//   (e) finalizeReceipt / validateReceiptShape / emit path not FAILING CLOSED
//
// HONESTY BOUNDARY (enforced below): a reserved-but-unfilled extended field is
// NOT a finding. A finding is logged ONLY when the composition turns a
// rejected/denied/partial evidence set into a strictly more-accepting outcome, or
// emits/validates a receipt whose stated outcome contradicts its own evidence.

import {
  createReceipt,
  validateReceiptShape,
  mergeFragment,
  composeOutcome,
  finalizeReceipt,
  promoteReceiptToManifest,
  signReceiptManifest,
} from "./receipt-hub.mjs";

import { verifyManifestProfileA } from "../signing/um-signature-profile-a.mjs";
import { generateKeyPair } from "../signing/ed25519.mjs";

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
  console.log(`      ⚠️  VULNERABLE (${severity})`);
  console.log(`      repro: ${repro}`);
}
function note(id, title, detail) {
  notes.push(id);
  console.log(`[${id}] ${title}`);
  console.log(`      NOTE: ${detail}`);
}

/** Compose a finalized receipt from plain-data fragments the way every consumer
 *  does (createReceipt -> mergeFragment×N -> finalizeReceipt), threading the
 *  sticky-rejected diagnostic exactly as the verifier's composeFromFragments. */
function composeFromFragments(fragments, { manifestId = "urn:uuid:attack", omitProcessedAt = true } = {}) {
  const receipt = createReceipt({ manifestId });
  let rejected = false;
  const conflicts = [];
  for (const frag of fragments) {
    const diag = mergeFragment(receipt, frag);
    if (diag.rejected) rejected = true;
    if (diag.conflicts.length) conflicts.push(...diag.conflicts);
  }
  const finalized = finalizeReceipt(receipt, { rejected, omitProcessedAt });
  return { receipt: finalized, rejected, conflicts };
}

// ===========================================================================
async function run() {
  console.log("runtime receipt-hub composition — adversarial attack vectors");
  console.log("===========================================================\n");

  // -------------------------------------------------------------------------
  // (a) STICKY-REJECTED — can a rejected verdict be LOST in the merge?
  // -------------------------------------------------------------------------

  // V1a — a tier fragment that rejects
  // MUST make the composed receipt rejected even when its facetStatuses would
  // otherwise compose to accepted.
  {
    const { receipt } = composeFromFragments([
      { engine: "runtime", verdict: "rejected", facetStatuses: [{ facetId: "urn:f:a", status: "processed" }] },
    ]);
    if (receipt.outcome === "rejected") {
      resisted("V1a", "sticky-rejected via verdict-only fragment (runtime shape)",
        `verdict:"rejected" + a processed facet still finalized outcome="${receipt.outcome}"`);
    } else {
      vulnerable("V1a", "rejected verdict LOST for a verdict-only fragment", "high",
        `fragment {verdict:"rejected", facet processed} composed to outcome="${receipt.outcome}"`);
    }
  }

  // V1b — the outcome/verdict PRECEDENCE gap. mergeFragment computes
  // `contribution = isNonEmptyString(f.outcome) ? f.outcome : f.verdict`, so a
  // fragment carrying BOTH a non-rejected `outcome` and a `verdict:"rejected"`
  // silently loses the rejection (diag.rejected=false).
  {
    const receipt = createReceipt({ manifestId: "urn:uuid:v1b" });
    const diag = mergeFragment(receipt, { engine: "hybrid", outcome: "accepted-partial", verdict: "rejected" });
    const final = finalizeReceipt(receipt, { rejected: diag.rejected, omitProcessedAt: true });
    if (diag.rejected === true) {
      resisted("V1b", "outcome/verdict co-emission still captures rejection",
        `diag.rejected=${diag.rejected}, outcome="${final.outcome}"`);
    } else {
      note("V1b", "outcome-preferred-over-verdict drops a co-emitted rejection (latent, LOW)",
        `a fragment with BOTH outcome:"accepted-partial" AND verdict:"rejected" yields diag.rejected=false ` +
        `→ finalized outcome="${final.outcome}". No CURRENT engine co-emits both (runtime is verdict-only; ` +
        `runtime/122/139 are outcome-only), so this is a defense-in-depth gap, not a reachable exploit today. ` +
        `Fix: treat a "rejected" in EITHER member as sticky (contribution should reject if outcome==="rejected" || verdict==="rejected").`);
    }
  }

  // -------------------------------------------------------------------------
  // (b) DENIED -> PROCESSED — can the overridable `processed` baseline win?
  // -------------------------------------------------------------------------

  // V2 — a consent-denied facet must NOT be replaced by a later `processed` for
  // the same facetId, in EITHER merge order (duplicate-facetId attack).
  {
    const a = composeFromFragments([
      { engine: "runtime", facetStatuses: [{ facetId: "urn:f:x", status: "consent-denied" }] },
      { engine: "runtime", facetStatuses: [{ facetId: "urn:f:x", status: "processed" }] },
    ]);
    const b = composeFromFragments([
      { engine: "runtime", facetStatuses: [{ facetId: "urn:f:x", status: "processed" }] },
      { engine: "runtime", facetStatuses: [{ facetId: "urn:f:x", status: "consent-denied" }] },
    ]);
    const held = (r) => (r.receipt.facetStatuses.find((f) => f.facetId === "urn:f:x") || {}).status === "consent-denied";
    const outcomesOk = a.receipt.outcome === "accepted-partial" && b.receipt.outcome === "accepted-partial";
    if (held(a) && held(b) && outcomesOk) {
      resisted("V2", "consent-denied is sticky against a duplicate-facetId `processed` (both merge orders)",
        `denied-first outcome="${a.receipt.outcome}", processed-first outcome="${b.receipt.outcome}"; denied held both ways`);
    } else {
      vulnerable("V2", "consent-denied overridden by the processed baseline", "high",
        `denied-first status="${(a.receipt.facetStatuses.find((f) => f.facetId === "urn:f:x") || {}).status}" outcome="${a.receipt.outcome}"; ` +
        `processed-first status="${(b.receipt.facetStatuses.find((f) => f.facetId === "urn:f:x") || {}).status}" outcome="${b.receipt.outcome}"`);
    }
  }

  // -------------------------------------------------------------------------
  // (c) FAILURE-DOMINANT ROLL-UPS — holderBinding / presentationProof / tier
  // -------------------------------------------------------------------------

  // V5 — holderBindingStatus: failed (dominance 3) must survive a later verified.
  {
    const a = composeFromFragments([
      { engine: "runtime", holderBindingStatus: "failed", signatureCheck: "valid", freshnessCheck: "fresh" },
      { engine: "runtime", holderBindingStatus: "verified" },
    ]);
    const b = composeFromFragments([
      { engine: "runtime", holderBindingStatus: "verified", signatureCheck: "valid", freshnessCheck: "fresh" },
      { engine: "runtime", holderBindingStatus: "failed" },
    ]);
    // also try to sneak an out-of-map junk status BEFORE a failed (dominance ?? -1)
    const c = composeFromFragments([
      { holderBindingStatus: "failed", signatureCheck: "valid", freshnessCheck: "fresh" },
      { holderBindingStatus: "verified-somehow" }, // not in HOLDER_BINDING_STATUSES / dominance map
    ]);
    const cThrewOrHeld = c.receipt.holderBindingStatus === "failed";
    if (a.receipt.holderBindingStatus === "failed" && b.receipt.holderBindingStatus === "failed" && cThrewOrHeld) {
      resisted("V5", "holderBindingStatus failure-dominant (failed > verified) both orders + junk status",
        `failed-first="${a.receipt.holderBindingStatus}", verified-first="${b.receipt.holderBindingStatus}", after-junk="${c.receipt.holderBindingStatus}"`);
    } else {
      vulnerable("V5", "failure-dominant holderBinding broken — verified won over failed", "high",
        `failed-first="${a.receipt.holderBindingStatus}", verified-first="${b.receipt.holderBindingStatus}"`);
    }
  }

  // V6 — effectiveTrustTier 0-sticky: a Tier-0 cap can never be un-capped.
  {
    const a = composeFromFragments([
      { engine: "runtime", effectiveTrustTier: 0, signatureCheck: "valid", freshnessCheck: "fresh" },
      { engine: "runtime", effectiveTrustTier: 3 },
    ]);
    const b = composeFromFragments([
      { engine: "runtime", effectiveTrustTier: 3, signatureCheck: "valid", freshnessCheck: "fresh" },
      { engine: "runtime", effectiveTrustTier: 0 },
    ]);
    if (a.receipt.effectiveTrustTier === 0 && b.receipt.effectiveTrustTier === 0) {
      resisted("V6", "effectiveTrustTier 0-cap is sticky (both merge orders)",
        `cap-first=${a.receipt.effectiveTrustTier}, raise-first=${b.receipt.effectiveTrustTier}`);
    } else {
      vulnerable("V6", "Tier-0 cap raised by a later fragment", "high",
        `cap-first=${a.receipt.effectiveTrustTier}, raise-first=${b.receipt.effectiveTrustTier}`);
    }
  }

  // V7 — presentationProofStatus: failed (dominance 3) survives a later verified.
  {
    const a = composeFromFragments([
      { engine: "runtime", presentationProofStatus: "failed", signatureCheck: "valid", freshnessCheck: "fresh" },
      { engine: "runtime", presentationProofStatus: "verified" },
    ]);
    if (a.receipt.presentationProofStatus === "failed") {
      resisted("V7", "presentationProofStatus failure-dominant (failed > verified)",
        `after verified merge, status="${a.receipt.presentationProofStatus}"`);
    } else {
      vulnerable("V7", "failure-dominant presentationProof broken", "high",
        `status="${a.receipt.presentationProofStatus}"`);
    }
  }

  // -------------------------------------------------------------------------
  // (d) COMPOSE-OUTCOME MAPPING BYPASS via merge-order + same-key conflicts.
  //     mergeFragment resolves same-key facet/claim conflicts KEEP-FIRST (only a
  //     diagnostic), NOT by outcome severity — unlike the dominance-ranked
  //     holderBinding / tier roll-ups. Because composeOutcome ranks statuses by
  //     severity, a lower-severity status merged FIRST can suppress a
  //     higher-severity same-key status and flip the outcome up.
  // -------------------------------------------------------------------------

  // V3 — facetStatuses: an assuranceInsufficient (reject path when nothing
  // processed) masked by an earlier consent-denied (partial path) on the SAME
  // facetId. Recommended order (assurance BEFORE consent) is safe; the reverse
  // — reachable by any consumer that does not honor the documented order — drops
  // the reject.
  {
    // baseline sanity: assuranceInsufficient alone, nothing processed => rejected.
    const solo = composeOutcome({ facetStatuses: [{ facetId: "urn:f:m", status: "assuranceInsufficient" }] });

    // recommended order: assurance(135) merged BEFORE consent(122) — safe.
    const safe = composeFromFragments([
      { engine: "runtime", facetStatuses: [{ facetId: "urn:f:m", status: "assuranceInsufficient", assuranceStatus: { assertedClass: "hardware-bound", met: false } }] },
      { engine: "runtime", facetStatuses: [{ facetId: "urn:f:m", status: "consent-denied", consentRef: "urn:c:1" }] },
    ]);

    // WRONG order: consent(122) merged BEFORE assurance(135) — same facetId.
    const attack = composeFromFragments([
      { engine: "runtime", facetStatuses: [{ facetId: "urn:f:m", status: "consent-denied", consentRef: "urn:c:1" }] },
      { engine: "runtime", facetStatuses: [{ facetId: "urn:f:m", status: "assuranceInsufficient", assuranceStatus: { assertedClass: "hardware-bound", met: false } }] },
    ]);

    console.log(`      [context] composeOutcome(assuranceInsufficient alone) = "${solo}" (spec: rejected)`);
    console.log(`      [context] recommended order (assurance-first) outcome = "${safe.receipt.outcome}"; conflicts=${JSON.stringify(safe.conflicts)}`);
    if (solo === "rejected" && safe.receipt.outcome === "rejected" && attack.receipt.outcome !== "rejected") {
      vulnerable("V3", "facet conflict is keep-first, not severity-dominant: a reject-worthy assuranceInsufficient is masked by an earlier consent-denied on the same facetId", "medium",
        `merge order [consent-denied@urn:f:m THEN assuranceInsufficient@urn:f:m], nothing processed → ` +
        `finalized outcome="${attack.receipt.outcome}" (expected "rejected"); the assuranceInsufficient entry was DROPPED ` +
        `(only diagnostic: ${JSON.stringify(attack.conflicts)}); the same diagnostics in the RECOMMENDED order finalizes "rejected". ` +
        `Root cause: mergeFragment keeps the first specific status and records a conflict that finalizeReceipt/composeOutcome never consult. ` +
        `Fix: rank facet statuses by outcome severity (assuranceInsufficient > consent-denied/opaque/... > processed) instead of keep-first, mirroring HB_DOMINANCE.`);
    } else if (attack.receipt.outcome === "rejected") {
      resisted("V3", "facet conflict preserves the reject-worthy status regardless of order",
        `wrong-order outcome="${attack.receipt.outcome}"`);
    } else {
      note("V3", "facet conflict masking inconclusive", `solo=${solo}, safe=${safe.receipt.outcome}, attack=${attack.receipt.outcome}`);
    }
  }

  // V3b — same root cause with a `written` status masking the
  // assuranceInsufficient reject on the SAME facetId under a wrong order.
  {
    const attack = composeFromFragments([
      { engine: "runtime", facetStatuses: [{ facetId: "urn:f:w", status: "written" }] },
      { engine: "runtime", facetStatuses: [{ facetId: "urn:f:w", status: "assuranceInsufficient", assuranceStatus: { assertedClass: "hardware-bound", met: false } }] },
    ]);
    if (attack.receipt.outcome !== "rejected") {
      vulnerable("V3b", "written status masks an assuranceInsufficient reject on the same facetId (keep-first)", "medium",
        `[written@urn:f:w THEN assuranceInsufficient@urn:f:w] → outcome="${attack.receipt.outcome}" (expected "rejected"); ` +
        `assuranceInsufficient DROPPED (conflict: ${JSON.stringify(attack.conflicts)}) and the surviving "written" satisfies composeOutcome's hasProcessed → reject suppressed.`);
    } else {
      resisted("V3b", "written cannot mask an assuranceInsufficient reject", `outcome="${attack.receipt.outcome}"`);
    }
  }

  // V4 — claimStatuses: a trustTierUnsupported (partial path) masked by an
  // earlier `bound` on the SAME claimRef → the tier cap is lost (accepted).
  {
    const solo = composeOutcome({ facetStatuses: [], claimStatuses: [{ claimRef: "urn:cl:1", status: "trustTierUnsupported", tier: 0 }] });

    const safe = composeFromFragments([
      { engine: "runtime", claimStatuses: [{ claimRef: "urn:cl:1", status: "trustTierUnsupported", tier: 0 }], effectiveTrustTier: 0, signatureCheck: "valid", freshnessCheck: "fresh" },
      { engine: "runtime", claimStatuses: [{ claimRef: "urn:cl:1", status: "bound", tier: 1 }] },
    ]);

    const attack = composeFromFragments([
      { engine: "runtime", claimStatuses: [{ claimRef: "urn:cl:1", status: "bound", tier: 1 }], signatureCheck: "valid", freshnessCheck: "fresh" },
      { engine: "runtime", claimStatuses: [{ claimRef: "urn:cl:1", status: "trustTierUnsupported", tier: 0 }], effectiveTrustTier: 0 },
    ]);

    const attackClaim = (attack.receipt.claimStatuses || []).find((c) => c.claimRef === "urn:cl:1") || {};
    console.log(`      [context] composeOutcome(trustTierUnsupported claim alone) = "${solo}" (spec: accepted-partial)`);
    console.log(`      [context] tier-first (recommended) outcome = "${safe.receipt.outcome}"`);
    if (solo === "accepted-partial" && safe.receipt.outcome === "accepted-partial" && attack.receipt.outcome === "accepted") {
      vulnerable("V4", "claim conflict is keep-first: a trustTierUnsupported tier-cap is masked by an earlier `bound` on the same claimRef", "medium",
        `merge order [bound@urn:cl:1 THEN trustTierUnsupported@urn:cl:1] → finalized outcome="${attack.receipt.outcome}" (expected "accepted-partial"); ` +
        `surviving claim status="${attackClaim.status}" tier=${attackClaim.tier}, yet effectiveTrustTier=${attack.receipt.effectiveTrustTier} (capped) — a self-contradicting receipt. ` +
        `trustTierUnsupported was DROPPED (conflict: ${JSON.stringify(attack.conflicts)}). Same keep-first root cause as V3; mitigated ONLY by the documented "merge runtime first" convention.`);
    } else {
      resisted("V4", "claim tier-cap survives regardless of merge order",
        `tier-first="${safe.receipt.outcome}", bound-first="${attack.receipt.outcome}"`);
    }
  }

  // V8 — composeOutcome rule-1 probe: assuranceInsufficient on one facet + a
  // legitimately processed/written DIFFERENT facet must be accepted-partial (NOT
  // rejected) because something WAS processed. Confirms rule-1 semantics; the
  // reject path fires only when NOTHING is processed.
  {
    const out = composeOutcome({
      facetStatuses: [
        { facetId: "urn:f:below", status: "assuranceInsufficient" },
        { facetId: "urn:f:other", status: "written" },
      ],
    });
    if (out === "accepted-partial") {
      note("V8", "rule-1 'nothing processed' correctly counts `written` as processed (by-design)",
        `assuranceInsufficient@A + written@B (distinct facets) → "${out}"; the reject path requires that NOTHING be processed/written. ` +
        `This is correct partial-acceptance, not a bypass. (Contrast V3b, where a same-facetId collision DROPS the assuranceInsufficient entirely.)`);
    } else {
      note("V8", "rule-1 probe", `outcome="${out}"`);
    }
  }

  // -------------------------------------------------------------------------
  // (e) FAIL-CLOSED — finalizeReceipt / validateReceiptShape / emit path.
  // -------------------------------------------------------------------------

  // V9 — finalizeReceipt MUST throw on every shape violation (the fail-closed
  // keystone). Battery of malformed/incomplete receipts.
  {
    const mkGood = () => {
      const r = createReceipt({ manifestId: "urn:uuid:v9" });
      r.signatureCheck = "valid";
      r.freshnessCheck = "fresh";
      return r;
    };
    const breaks = [
      ["missing-manifestId", (r) => { delete r.manifestId; }],
      ["null-manifestId", (r) => { r.manifestId = null; }],
      ["nonarray-facetStatuses", (r) => { r.facetStatuses = null; }],
      ["9th-facet-status", (r) => { r.facetStatuses.push({ facetId: "urn:x", status: "sealed" }); }],
      ["warning-missing-message", (r) => { r.warnings.push({ code: "um:reason:x" }); }],
      ["tier-out-of-range", (r) => { r.effectiveTrustTier = 4; }],
      ["bad-holderBinding", (r) => { r.holderBindingStatus = "totally-bound"; }],
      ["bad-prevHash", (r) => { r.prevHash = "md5:nope"; }],
      ["bad-type", (r) => { r["@type"] = "um:Manifest"; }],
      ["nonobject-facet", (r) => { r.facetStatuses.push({ facetId: "urn:y", status: "processed" }); r.facetStatuses.push("not-an-object"); }],
    ];
    let allThrew = true;
    const survived = [];
    for (const [name, breakFn] of breaks) {
      const r = mkGood();
      breakFn(r);
      let threw = false;
      try { finalizeReceipt(r, { omitProcessedAt: true }); } catch { threw = true; }
      if (!threw) { allThrew = false; survived.push(name); }
    }
    if (allThrew) {
      resisted("V9", "finalizeReceipt fails closed on every shape violation (10/10 threw)",
        "missing/null required members, 9th facet status, malformed warning, tier>3, bad enum, bad prevHash, wrong @type, non-object facet — all rejected");
    } else {
      vulnerable("V9", "finalizeReceipt accepted a malformed receipt", "high",
        `these shape violations did NOT throw: ${survived.join(", ")}`);
    }
  }

  // V10 — THE FAIL-CLOSED BYPASS. finalizeReceipt (which RE-DERIVES outcome via
  // composeOutcome) is the only guard that checks outcome-vs-evidence. The emit
  // path promoteReceiptToManifest()/signReceiptManifest() only calls
  // validateReceiptShape() — which checks members/enums but NEVER cross-checks
  // `outcome` against facetStatuses. A hand-built receipt whose stated outcome
  // contradicts its own evidence is therefore promoted and SIGNED verbatim.
  {
    // Case 1: outcome "accepted" while a facet is consent-denied
    //         (composeOutcome would say "accepted-partial").
    const denied = {
      "@type": "um:Receipt",
      manifestId: "urn:uuid:evil-denied",
      outcome: "accepted",
      signatureCheck: "valid",
      freshnessCheck: "fresh",
      facetStatuses: [{ facetId: "urn:f:secret", status: "consent-denied", consentRef: "urn:c:z" }],
      warnings: [],
    };
    // Case 2: outcome "accepted" while a facet is assuranceInsufficient and
    //         nothing is processed (composeOutcome would say "rejected").
    const rejectWorthy = {
      "@type": "um:Receipt",
      manifestId: "urn:uuid:evil-reject",
      outcome: "accepted",
      signatureCheck: "valid",
      freshnessCheck: "fresh",
      facetStatuses: [{ facetId: "urn:f:below", status: "assuranceInsufficient", assuranceStatus: { assertedClass: "hardware-bound", met: false } }],
      warnings: [],
    };

    const shapeDenied = validateReceiptShape(denied).valid;
    const shapeReject = validateReceiptShape(rejectWorthy).valid;
    const composeDenied = composeOutcome(denied);       // "accepted-partial"
    const composeReject = composeOutcome(rejectWorthy); // "rejected"

    let promotedDenied = null, promotedReject = null, promoteThrew = "";
    try {
      promotedDenied = promoteReceiptToManifest(denied, { subject: "did:web:attacker.example:world" });
      promotedReject = promoteReceiptToManifest(rejectWorthy, { subject: "did:web:attacker.example:world" });
    } catch (e) { promoteThrew = e.message; }

    // And prove it reaches the WIRE with a VALID signature.
    let signedVerifies = false, signedOutcome = "";
    try {
      const keys = await generateKeyPair();
      const signed = await signReceiptManifest(rejectWorthy, { subject: "did:web:attacker.example:world" }, keys.seed);
      signedOutcome = signed.outcome;
      signedVerifies = (await verifyManifestProfileA(signed)).ok === true;
    } catch (e) { promoteThrew = promoteThrew || e.message; }

    console.log(`      [context] validateReceiptShape: denied=${shapeDenied}, rejectWorthy=${shapeReject} (both shape-valid)`);
    console.log(`      [context] composeOutcome DISAGREES: denied→"${composeDenied}", rejectWorthy→"${composeReject}"; stated outcome="accepted"`);

    const bypassed = shapeDenied && shapeReject && promotedDenied && promotedReject &&
      promotedDenied.outcome === "accepted" && promotedReject.outcome === "accepted" &&
      composeDenied === "accepted-partial" && composeReject === "rejected";

    if (bypassed) {
      vulnerable("V10", "emit path (promoteReceiptToManifest/signReceiptManifest) is NOT fail-closed on outcome-vs-diagnostics — finalizeReceipt keystone bypassable", "medium",
        `a receipt with outcome:"accepted" carrying a consent-denied facet (composeOutcome="accepted-partial") AND one with an ` +
        `assuranceInsufficient-nothing-processed facet (composeOutcome="rejected") both pass validateReceiptShape and are promoted to ` +
        `@type ["um:Manifest","um:Receipt"] with outcome="accepted" unchanged` +
        (signedVerifies ? `, then SIGNED and the signature VERIFIES (signed outcome="${signedOutcome}") — a validly-signed rejected-as-accepted receipt on the wire` : "") +
        `. validateReceiptShape checks members/enums only; it never re-derives or cross-checks outcome, and promote/sign never call composeOutcome/finalizeReceipt. ` +
        `Reachable whenever an emitter builds a receipt without routing it through finalizeReceipt (nothing enforces finalize-before-emit). ` +
        `Fix: promoteReceiptToManifest should refuse a receipt whose outcome !== composeOutcome (unless an explicit, recorded outcomeOverride attests the divergence), or run finalizeReceipt internally.`);
    } else if (promoteThrew) {
      resisted("V10", "emit path refused the outcome-inconsistent receipt", `promote/sign threw: ${promoteThrew}`);
    } else {
      note("V10", "emit-path outcome-consistency probe inconclusive",
        `shapeDenied=${shapeDenied} shapeReject=${shapeReject} promotedDenied.outcome=${promotedDenied?.outcome} promotedReject.outcome=${promotedReject?.outcome}`);
    }
  }

  // V12 — outcomeOverride outranks the sticky-rejected flag. finalizeReceipt
  // applies outcomeOverride BEFORE the `rejected` branch, so a caller-supplied
  // override silences a live rejection. Caller-controlled + documented
  //so INFORMATIONAL — but flagged as a design sharp edge.
  {
    const r = createReceipt({ manifestId: "urn:uuid:v12" });
    r.signatureCheck = "valid";
    r.freshnessCheck = "fresh";
    const final = finalizeReceipt(r, { rejected: true, outcomeOverride: "accepted", omitProcessedAt: true });
    if (final.outcome === "accepted") {
      note("V12", "outcomeOverride outranks sticky-rejected (by-design, caller-controlled)",
        `finalizeReceipt({rejected:true, outcomeOverride:"accepted"}) → outcome="${final.outcome}". This is the documented runtime backcompat lever, ` +
        `but note the override wins over a LIVE rejection and is not validated against composeOutcome. Hardening idea: forbid overriding a rejected ` +
        `receipt to a clean "accepted", or restrict overrides to {accepted-with-warnings, accepted-partial}.`);
    } else {
      resisted("V12", "outcomeOverride cannot silence a rejection", `outcome="${final.outcome}"`);
    }
  }

  // V11 — empty-string facetId collides on the merge key (`facetId ?? name` uses
  // nullish coalescing, so "" is NOT replaced by name). Distinct facets with
  // facetId:"" are conflated. Security direction stays safe (denied/assurance
  // survives), but distinct facets are silently merged/dropped — data integrity.
  {
    const { receipt } = composeFromFragments([
      { facetStatuses: [{ facetId: "", name: "processed-facet", status: "processed" }] },
      { facetStatuses: [{ facetId: "", name: "denied-facet", status: "consent-denied", consentRef: "urn:c:q" }] },
    ]);
    const collapsed = receipt.facetStatuses.length === 1;
    const safeDirection = receipt.outcome === "accepted-partial";
    if (collapsed && safeDirection) {
      note("V11", "empty-string facetId collides on the merge key (data-integrity, safe outcome)",
        `two DISTINCT facets both with facetId:"" collapse to ${receipt.facetStatuses.length} entry (status="${receipt.facetStatuses[0].status}"), outcome="${receipt.outcome}". ` +
        `The denied status survives (safe security direction) but a distinct facet is silently lost. Root cause: \`entry.facetId ?? entry.name\` treats "" as present. ` +
        `Fix: key on a non-empty facetId OR name (isNonEmptyString guard) so empty ids fall back to name.`);
    } else {
      resisted("V11", "empty-string facetId does not conflate distinct facets",
        `entries=${receipt.facetStatuses.length}, outcome="${receipt.outcome}"`);
    }
  }

  // -------------------------------------------------------------------------
  // summary
  // -------------------------------------------------------------------------
  console.log("\n===========================================================");
  console.log(`RESISTED: ${resistedList.length}   FINDINGS: ${findings.length}   NOTES: ${notes.length}`);
  if (findings.length === 0) {
    console.log("VERDICT: SOUND — every hard attack vector resisted.");
  } else {
    console.log("VERDICT: FINDINGS STAND — ranked (composition can turn a rejected/denied result more-accepting):");
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
