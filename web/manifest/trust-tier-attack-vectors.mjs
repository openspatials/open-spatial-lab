#!/usr/bin/env node
// ADVERSARIAL ATTACK VECTORS against the trust-tier engine.
//
// This file is ADDITIVE and READ-ONLY toward the module under test: it imports the
// PUBLIC API of web/manifest/trust-tier.mjs and tries to BREAK its security
// invariants. It modifies nothing in the engine and flips no conformance flag.
//
// The trust-tier engine's raise-only / cap / no-downgrade rules are a SECURITY
// property: any bypass is a SILENT TRUST ELEVATION. This harness constructs concrete
// attack vectors for the five real vulnerability classes and reports RESISTED or
// ⚠️VULNERABLE for each, with a reproduction. It is NOT a conformance re-run — the
// standalone verify driver (trust-tier-verify.mjs) proves fixture parity.
//
//   Class (a) NO-DOWNGRADE violation accepted  — AV-01, AV-02, AV-03, AV-13
//   Class (b) CAP BYPASS / re-elevation        — AV-04, AV-05, AV-09
//   Class (c) TIER-0 STICKINESS broken (merge)  — AV-06, AV-07
//   Class (d) HOSTILE PROVIDER-OUTPUT trusted   — AV-08, AV-11, AV-16
//   Class (e) RAISE-ONLY violated               — AV-01, AV-02, AV-03, AV-14
//   Cross-cutting elevation invariants          — AV-10, AV-11, AV-12
//
// HONESTY BOUNDARY (per the task): DEFAULT_MAX_SUPPORTED_TRUST_TIER=1 with Tier-2/3
// failing closed is the INTENDED PREVIEW capability boundary, NOT a vulnerability, and
// is therefore not attacked as one. Every vector below targets an ELEVATION path only.
//
// EXIT: 0 iff zero ⚠️VULNERABLE findings (engine SOUND). Non-zero otherwise.

import {
  TRUST_TIER_MAX,
  DEFAULT_MAX_SUPPORTED_TRUST_TIER,
  BINDING_VERIFIED,
  BINDING_FAILED,
  BINDING_ABSENT,
  BINDING_PRESENT_UNVERIFIED,
  isTrustTier,
  effectiveFloor,
  checkFloors,
  evaluateTrustTiers,
  negotiateBilateralFloor,
} from "./trust-tier.mjs";

// ---- local mirror of the engine's tier coercion (for computing EXPECTED bounds) ----
// (Not imported — we recompute independently so an assertion never trusts the engine
// under test to grade itself.)
const effTier = (v) => (Number.isInteger(v) && v >= 0 && v <= 3 ? v : 0);

// ---- report plumbing -------------------------------------------------------
let RESISTED = 0;
let VULNERABLE = 0;
const findings = [];

function resisted(id, name, diagnostics) {
  RESISTED += 1;
  console.log(`RESISTED     ${id}  ${name}`);
  if (diagnostics) console.log(`               ${diagnostics}`);
}
function vulnerable(id, name, repro) {
  VULNERABLE += 1;
  findings.push({ id, name, repro });
  console.error(`⚠️VULNERABLE  ${id}  ${name}`);
  if (repro) console.error(`               REPRO: ${repro}`);
}
function note(msg) {
  console.log(`               note: ${msg}`);
}
// verdict(true) => RESISTED, verdict(false) => VULNERABLE. `breachRepro` explains the
// concrete elevation that WOULD have occurred if the assertion failed.
function verdict(id, name, resistedCondition, diagnostics, breachRepro) {
  if (resistedCondition) resisted(id, name, diagnostics);
  else vulnerable(id, name, breachRepro);
}

// deterministic PRNG for reproducible fuzzing (mulberry32).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log("=== runtime trust-tier engine — ADVERSARIAL attack vectors ===\n");
console.log(
  "Target (READ-ONLY): web/manifest/trust-tier.mjs\n" +
    "Goal: drive a SILENT TRUST ELEVATION — downgrade a floor, bypass/re-elevate a\n" +
    "Tier-0 cap, unstick Tier-0 in a merge, get hostile provider output trusted, or\n" +
    "violate raise-only. Each vector prints RESISTED or ⚠️VULNERABLE.\n"
);

// ===========================================================================
// CLASS (a)/(e) — NO-DOWNGRADE / RAISE-ONLY floor bypass attempts
// ===========================================================================
console.log("--- CLASS (a)/(e): raise-only floor + no-downgrade bypass ---");

// AV-01 — TOCTOU getter: claim.requiredTrustTier reads HIGH during the floor check
// (dodging the structural violation) then LOW during reliance. If the low read wins,
// the claim is relied upon BELOW the manifest floor — a downgrade.
{
  const manifestFloor = 1;
  let reads = 0;
  const claim = {
    "@id": "urn:um:attack:toctou-claim",
    "@type": "membership.organization",
    get requiredTrustTier() {
      reads += 1;
      return reads === 1 ? 1 : 0; // 1st read (checkFloors): == floor, no violation; later: 0
    },
  };
  const frag = evaluateTrustTiers(
    { requiredTrustTier: manifestFloor, claims: [claim] },
    { maxSupportedTrustTier: 1, holderBindingStatusOf: () => BINDING_PRESENT_UNVERIFIED }
  );
  // The claim, if relied upon, must carry an effective tier >= manifest floor.
  const relied = frag.deferredClaims.find((d) => d.claimRef === "urn:um:attack:toctou-claim");
  const capped = frag.claimStatuses.find((s) => s.claimRef === "urn:um:attack:toctou-claim");
  const reliedTier = relied ? relied.tier : capped ? capped.tier : undefined;
  const below = relied && relied.tier < manifestFloor; // ONLY a leak if it is RELIED at < floor
  verdict(
    "AV-01",
    "TOCTOU getter can't relied-drop a claim below the manifest floor",
    !below,
    `getter read ${reads}x; reliance tier resolved to ${reliedTier} (floor ${manifestFloor}) — effectiveFloor(max) re-raises regardless of the 2nd read`,
    `claim relied upon at tier ${reliedTier} < manifest floor ${manifestFloor} via getter TOCTOU`
  );
}

// AV-02 — TYPE-COERCION downgrade: a claim declares a floor BELOW the manifest floor
// using a non-integer type so checkFloors' `isTrustTier(declared)` guard skips it.
// If the coercion path let it be RELIED below the floor, that's a downgrade.
{
  const manifestFloor = 2;
  const evilTiers = [0.5, 1.9, "1", "0", true, false, [1], [0], { valueOf: () => 0 }, NaN, -0.0001, null];
  let worstReliedTier = Infinity;
  let example = null;
  for (const t of evilTiers) {
    const cf = checkFloors({ requiredTrustTier: manifestFloor, claims: [{ "@type": "t", requiredTrustTier: t }] });
    const merged = effectiveFloor(manifestFloor, t); // reliance tier the engine will use
    if (merged < worstReliedTier) {
      worstReliedTier = merged;
      example = t;
    }
    // structural check must NOT falsely PASS a genuine violation, but for a NON-tier
    // value the correct behavior is: no structural violation AND reliance raised to floor.
    if (cf.ok === false) {
      // a violation was flagged (fine); still confirm reliance not below floor.
    }
  }
  verdict(
    "AV-02",
    "type-coerced sub-floor claim tier is raised to the manifest floor (never relied below)",
    worstReliedTier >= manifestFloor,
    `worst reliance tier across ${evilTiers.length} coercion payloads = ${worstReliedTier} (>= floor ${manifestFloor}); e.g. requiredTrustTier=${JSON.stringify(example)} → effectiveFloor=${worstReliedTier}`,
    `payload ${JSON.stringify(example)} produced reliance tier ${worstReliedTier} < manifest floor ${manifestFloor}`
  );
}

// AV-03 — FACET floor downgrade via coercion: same trick on a facet. A facet must be
// either recorded trustTierUnsupported or deferred at a tier >= floor — NEVER projected
// below the manifest floor.
{
  const manifestFloor = 2;
  const frag = evaluateTrustTiers(
    {
      requiredTrustTier: manifestFloor,
      facets: [
        { "@id": "urn:um:attack:facet-sub-a", "@type": "um:Facet", requiredTrustTier: 0.9 },
        { "@id": "urn:um:attack:facet-sub-b", "@type": "um:Facet", requiredTrustTier: "1" },
        { "@id": "urn:um:attack:facet-sub-c", "@type": "um:Facet", requiredTrustTier: [1] },
      ],
    },
    { maxSupportedTrustTier: 1 } // floor 2 > cap 1 ⇒ manifest-level unsupported
  );
  // manifest floor 2 exceeds cap 1 → whole manifest rejected; no facet is EVER projected.
  const noFacetProjectedBelowFloor = frag.deferredFacetIds.length === 0;
  const manifestRejected = frag.verdict === "rejected" && frag.rejectedBy === "manifest-tier-unsupported";
  verdict(
    "AV-03",
    "coerced sub-floor facet tiers cannot get a facet projected below the manifest floor",
    noFacetProjectedBelowFloor && manifestRejected,
    `verdict=${frag.verdict} rejectedBy=${frag.rejectedBy}; deferredFacetIds=${JSON.stringify(frag.deferredFacetIds)} (none projected)`,
    `a facet slipped into deferredFacetIds below floor ${manifestFloor}: ${JSON.stringify(frag.deferredFacetIds)}`
  );
}

// AV-13 — dodge the MANIFEST-LEVEL unsupported reject with a manifest-tier getter that
// reads 0 during the capability check, while claims/facets demand Tier 3. The per-item
// checks must BACKSTOP the dodged manifest-level reject (no Tier-3 item accepted).
{
  let mreads = 0;
  const manifest = {
    get requiredTrustTier() {
      mreads += 1;
      return 0; // always read as 0 ⇒ manifest-level check sees 0 > cap? no.
    },
    claims: [{ "@id": "urn:um:attack:t3-claim", "@type": "identity.crossDidBinding", requiredTrustTier: 3, bindingProof: {} }],
    facets: [{ "@id": "urn:um:attack:t3-facet", "@type": "um:Facet", requiredTrustTier: 3 }],
  };
  const frag = evaluateTrustTiers(manifest, { maxSupportedTrustTier: 1 });
  const claimCaught = frag.claimStatuses.some((s) => s.claimRef === "urn:um:attack:t3-claim" && s.status === "trustTierUnsupported");
  const facetCaught = frag.facetStatuses.some((s) => s.facetId === "urn:um:attack:t3-facet" && s.status === "trustTierUnsupported");
  const nothingT3Accepted = frag.deferredClaims.length === 0 && frag.deferredFacetIds.length === 0;
  verdict(
    "AV-13",
    "dodging the manifest-level reject (tier getter=0) still catches Tier-3 items per-item",
    claimCaught && facetCaught && nothingT3Accepted,
    `manifest tier read ${mreads}x as 0; Tier-3 claim & facet BOTH recorded trustTierUnsupported; zero items accepted (cap 1)`,
    `Tier-3 item accepted after the manifest-level reject was dodged`
  );
}

// ===========================================================================
// CLASS (b) — CAP BYPASS / re-elevation
// ===========================================================================
console.log("\n--- CLASS (b): Tier-0 cap bypass / re-elevation ---");

// AV-04 — avoid the Tier-0 CAP RECORD by attaching EMPTY (bogus) binding material so the
// presence-based default provider returns "present-unverified" instead of "absent".
// The security question: does this ELEVATE trust? (effectiveTrustTier must NOT reach ≥1,
// and the claim must NOT be reported verified.)
{
  const bare = { requiredTrustTier: 0, claims: [{ "@id": "urn:um:attack:bare", "@type": "membership.organization", requiredTrustTier: 1 }] };
  const decoy = { requiredTrustTier: 0, claims: [{ "@id": "urn:um:attack:decoy", "@type": "membership.organization", requiredTrustTier: 1, holderBinding: {} }] };
  const fBare = evaluateTrustTiers(bare, { maxSupportedTrustTier: 1 }); // default provider
  const fDecoy = evaluateTrustTiers(decoy, { maxSupportedTrustTier: 1 }); // default provider
  const noElevation =
    fDecoy.effectiveTrustTier === undefined && // NEVER ≥ 1 (undefined == absent, Base §3.3.1.1)
    (fDecoy.deferredClaims[0] ? fDecoy.deferredClaims[0].bindingStatus !== BINDING_VERIFIED : true);
  verdict(
    "AV-04",
    "empty holderBinding{} avoids the cap RECORD but yields NO trust elevation",
    noElevation,
    `bare: effTrustTier=${fBare.effectiveTrustTier} (tier-0 cap record). decoy: effTrustTier=${fDecoy.effectiveTrustTier} (undefined, i.e. absent), claim deferred as "${fDecoy.deferredClaims[0]?.bindingStatus}" (NOT verified)`,
    `empty binding elevated effectiveTrustTier to ${fDecoy.effectiveTrustTier} or marked the claim verified`
  );
  note(
    "SEAM (informational, not a vuln): the accepted-partial→accepted verdict shift + vanished " +
      "cap record means a consumer that treats \"deferred, no claimStatus\" as trusted WITHOUT running " +
      "the runtime binding verifier would be MISUSING the engine. The deferred claim's bindingStatus " +
      "\"present-unverified\" is the machine-readable \"NOT verified\" signal. No numeric elevation occurs."
  );
}

// AV-05 — CAP BYPASS via a SECOND evaluation. Evaluate a Tier-1 unbound claim (capped at
// Tier 0), then attempt to re-elevate on a second pass. A manifest attacker has no TCB
// leverage (max / provider are evaluator-owned). Re-elevation is possible ONLY by
// changing those privileged inputs — which the manifest cannot do.
{
  const m = { requiredTrustTier: 0, claims: [{ "@id": "urn:um:attack:reeval", "@type": "membership.organization", requiredTrustTier: 1 }] };
  const pass1 = evaluateTrustTiers(m, { maxSupportedTrustTier: 1 });
  const pass2 = evaluateTrustTiers(m, { maxSupportedTrustTier: 1 }); // identical manifest-controlled inputs
  const stableCap =
    pass1.effectiveTrustTier === 0 && pass2.effectiveTrustTier === 0 &&
    pass1.claimStatuses[0]?.tier === 0 && pass2.claimStatuses[0]?.tier === 0;
  // The ONLY way to change the outcome is to change TCB inputs (not attacker-controllable):
  const tcbFlip = evaluateTrustTiers(m, { maxSupportedTrustTier: 1, holderBindingStatusOf: () => BINDING_VERIFIED });
  const onlyTcbCanElevate = tcbFlip.effectiveTrustTier === 1; // requires trusting
  verdict(
    "AV-05",
    "a capped claim cannot be re-elevated by re-evaluation (no manifest-side leverage)",
    stableCap && onlyTcbCanElevate,
    `pass1/pass2 both cap at Tier 0 (pure fn, stateless); elevation to ${tcbFlip.effectiveTrustTier} required an EVALUATOR-owned verified provider, not a manifest change`,
    `re-evaluation elevated a capped claim without any TCB input change`
  );
}

// AV-09 — a hostile provider that reports EVERY binding "verified" cannot push
// effectiveTrustTier above the evaluator's capability ceiling (cap bypass via forged
// verification). Sweep claimTier × maxSupported.
{
  let breaches = [];
  let sweeps = 0;
  for (let ct = 0; ct <= TRUST_TIER_MAX; ct++) {
    for (let max = 0; max <= TRUST_TIER_MAX; max++) {
      const frag = evaluateTrustTiers(
        { requiredTrustTier: 0, claims: [{ "@id": "urn:c", "@type": "t", requiredTrustTier: ct, holderBinding: {} }] },
        { maxSupportedTrustTier: max, holderBindingStatusOf: () => BINDING_VERIFIED }
      );
      sweeps += 1;
      if (frag.effectiveTrustTier !== undefined && frag.effectiveTrustTier > max)
        breaches.push(`ct=${ct} max=${max} → effTrustTier=${frag.effectiveTrustTier}`);
      if (ct > max && frag.effectiveTrustTier !== undefined)
        breaches.push(`ct=${ct} max=${max}: unsupported claim still contributed effTrustTier=${frag.effectiveTrustTier}`);
    }
  }
  verdict(
    "AV-09",
    "forged \"verified\" provider cannot raise effectiveTrustTier above capability",
    breaches.length === 0,
    `${sweeps} (claimTier × capability) sweeps; effectiveTrustTier ≤ maxSupportedTrustTier everywhere; above-capability claims contribute nothing`,
    breaches.slice(0, 3).join(" | ")
  );
}

// ===========================================================================
// CLASS (c) — TIER-0 STICKINESS in a merge / multi-claim compose
// ===========================================================================
console.log("\n--- CLASS (c): Tier-0 stickiness in compose ---");

// AV-06 — a Tier-0-capped claim MUST NOT ride a sibling verified claim's tier. Compose a
// capped (unbound Tier-1) claim with a verified Tier-1 claim, BOTH orderings. The capped
// claim's own status must stay Tier 0; effectiveTrustTier reflects only the genuinely
// verified sibling (a different claim), never the capped one.
{
  const cappedClaim = { "@id": "urn:um:attack:capped", "@type": "t", requiredTrustTier: 1 }; // no binding → absent
  const verifiedClaim = { "@id": "urn:um:attack:verified", "@type": "t", requiredTrustTier: 1, holderBinding: { mode: "sd-jwt-kb", cnfThumbprint: "x" } };
  const provider = (c) => (c["@id"] === "urn:um:attack:verified" ? BINDING_VERIFIED : BINDING_ABSENT);
  const orderA = evaluateTrustTiers({ requiredTrustTier: 0, claims: [cappedClaim, verifiedClaim] }, { maxSupportedTrustTier: 1, holderBindingStatusOf: provider });
  const orderB = evaluateTrustTiers({ requiredTrustTier: 0, claims: [verifiedClaim, cappedClaim] }, { maxSupportedTrustTier: 1, holderBindingStatusOf: provider });
  const cappedStaysZero = (f) => {
    const cs = f.claimStatuses.find((s) => s.claimRef === "urn:um:attack:capped");
    const leaked = f.deferredClaims.find((d) => d.claimRef === "urn:um:attack:capped");
    return cs && cs.tier === 0 && !leaked; // capped claim never appears relied/deferred
  };
  const ok =
    cappedStaysZero(orderA) && cappedStaysZero(orderB) &&
    orderA.effectiveTrustTier === 1 && orderB.effectiveTrustTier === 1; // from the VERIFIED sibling only
  verdict(
    "AV-06",
    "capped Tier-0 claim stays Tier 0 regardless of order; only the verified sibling contributes",
    ok,
    `both orderings: capped claim recorded {tier 0}, never deferred; effectiveTrustTier=1 comes from the verified sibling (a different claim), order-independent`,
    `a capped claim's tier rose when composed after a verified sibling (stickiness broken)`
  );
}

// AV-07 — two capped claims, "failed" THEN "absent". Ordering must not let the capped
// value rise, and effectiveTrustTier must stay 0. (Fidelity note: the receipt-level
// holderBindingStatus is last-write-wins — observability only, no elevation.)
{
  const failedFirst = { "@id": "urn:um:attack:failed", "@type": "t", requiredTrustTier: 1, holderBinding: {} };
  const absentSecond = { "@id": "urn:um:attack:absent", "@type": "t", requiredTrustTier: 1 };
  const provider = (c) => (c["@id"] === "urn:um:attack:failed" ? BINDING_FAILED : BINDING_ABSENT);
  const frag = evaluateTrustTiers({ requiredTrustTier: 0, claims: [failedFirst, absentSecond] }, { maxSupportedTrustTier: 1, holderBindingStatusOf: provider });
  const bothZero = frag.claimStatuses.every((s) => s.tier === 0) && frag.claimStatuses.length === 2;
  const noElevation = frag.effectiveTrustTier === 0;
  verdict(
    "AV-07",
    "two capped claims stay Tier 0; ordering never elevates the capped value",
    bothZero && noElevation,
    `both claims recorded {tier 0}; effectiveTrustTier=0. receipt-level holderBindingStatus="${frag.holderBindingStatus}" (last-write-wins)`,
    `a capped claim rose above Tier 0 through cap ordering`
  );
  note(
    "FIDELITY (informational, not elevation): receipt-level holderBindingStatus is dominated by the " +
      "LAST capped claim, so a trailing \"absent\" claim masks an earlier \"failed\" (an active-attack " +
      "signal) at the SUMMARY level. Per-claim reasons still distinguish them and the tier stays 0 — " +
      "candidate hardening: summarize as the most-severe status (failed ≻ absent), not last-write-wins."
  );
}

// ===========================================================================
// CLASS (d) — HOSTILE PROVIDER-OUTPUT injection
// ===========================================================================
console.log("\n--- CLASS (d): hostile provider-output injection ---");

// AV-08 — a battery of MALFORMED provider outputs (out-of-vocabulary strings, wrong
// types, boxed String, Symbol, numbers, objects). Each MUST clamp fail-closed to
// "absent" → Tier-0 cap. Anything that slips to within/verified is a trust elevation.
{
  const malformed = [
    null, undefined, "", "verified ", " verified", "VERIFIED", "Verified", "trusted", "ok", "valid",
    "present", "unverified", "pass", "true", 0, 1, 2, 3, true, false, {}, [], ["verified"],
    { status: "verified" }, new String("verified"), Symbol("verified"), NaN, Infinity,
    () => BINDING_VERIFIED, /verified/, BigInt(1),
  ];
  const leaks = [];
  for (const out of malformed) {
    let frag;
    try {
      frag = evaluateTrustTiers(
        { requiredTrustTier: 0, claims: [{ "@id": "urn:c", "@type": "membership.organization", requiredTrustTier: 1 }] },
        { maxSupportedTrustTier: 1, holderBindingStatusOf: () => out }
      );
    } catch (e) {
      // A malformed output that CRASHES is fail-closed (no receipt) — acceptable, not a leak.
      continue;
    }
    const capped = frag.claimStatuses[0]?.tier === 0 && frag.holderBindingStatus === BINDING_ABSENT;
    const elevated = frag.deferredClaims.length > 0 || (frag.effectiveTrustTier ?? 0) > 0;
    if (!capped || elevated) leaks.push(`${describe(out)} → tier=${frag.claimStatuses[0]?.tier} hbs=${frag.holderBindingStatus} eff=${frag.effectiveTrustTier} deferred=${frag.deferredClaims.length}`);
  }
  verdict(
    "AV-08",
    "malformed provider outputs clamp fail-closed to \"absent\" (Tier-0 cap)",
    leaks.length === 0,
    `${malformed.length} malformed payloads (incl. boxed String, Symbol, numbers, objects, RegExp, BigInt) — every one normalized to "absent" and capped at Tier 0`,
    leaks.slice(0, 3).join(" | ")
  );
}

function describe(v) {
  if (v === null) return "null";
  if (typeof v === "object") return Array.isArray(v) ? `array(${v.length})` : v.constructor?.name || "object";
  if (typeof v === "symbol") return v.toString();
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "function") return "function";
  return `${typeof v}:${String(v)}`;
}

// AV-16 — a hostile provider that THROWS must fail CLOSED. Post-N3 the engine CATCHES the
// provider fault INSIDE evaluateTrustTiers and maps it to "absent" → a Tier-0 cap (was:
// propagate/crash). The SECURITY property is unchanged and strengthened: a provider fault
// yields NO trust elevation — never a relied/verified claim, never effectiveTrustTier >= 1,
// never a silently-"accepted" fragment; and it no longer crashes the composing pipeline.
{
  let threw = false;
  let frag = null;
  try {
    frag = evaluateTrustTiers(
      { requiredTrustTier: 0, claims: [{ "@id": "urn:c", "@type": "t", requiredTrustTier: 1 }] },
      { maxSupportedTrustTier: 1, holderBindingStatusOf: () => { throw new Error("hostile provider"); } }
    );
  } catch (e) {
    threw = true;
  }
  const failedClosedNoElevation =
    !threw && frag !== null &&                                // engine did not crash / propagate
    frag.effectiveTrustTier === 0 &&                          // capped at Tier 0, never >= 1
    frag.claimStatuses[0]?.status === "trustTierUnsupported" &&
    frag.claimStatuses[0]?.tier === 0 &&                      // claim recorded at the Tier-0 cap
    frag.holderBindingStatus === BINDING_ABSENT &&            // provider fault mapped to "absent"
    frag.deferredClaims.length === 0 &&                       // claim NOT relied upon
    frag.verdict !== "accepted";                              // not silently accepted
  verdict(
    "AV-16",
    "a throwing provider is caught and fails closed to a Tier-0 cap (no elevation)",
    failedClosedNoElevation,
    "provider exception CAUGHT inside evaluateTrustTiers and mapped to \"absent\" -> Tier-0 cap: effectiveTrustTier 0, claim recorded trustTierUnsupported, not relied, verdict accepted-partial — no silent acceptance, no elevation (N3)",
    `a throwing provider elevated trust or was silently accepted: ${JSON.stringify(frag)}`
  );
  note("N3 applied: holder-binding provider faults are caught in evaluateTrustTiers and fail closed (absent / Tier-0 cap); the engine no longer propagates and never crashes the composing pipeline.");
}

// ===========================================================================
// CROSS-CUTTING — elevation invariants under fuzzing
// ===========================================================================
console.log("\n--- CROSS-CUTTING: elevation invariants (fuzz) ---");

// AV-10 — with the DEFAULT (presence-based) provider — i.e. a pure MANIFEST-ONLY
// attacker with no TCB access — effectiveTrustTier can ONLY ever be undefined or 0.
// A manifest alone must NEVER reach effectiveTrustTier ≥ 1.
{
  const rnd = mulberry32(0xC0FFEE);
  const bindingMembers = ["holderBinding", "bindingProof", "ceremonyProof"];
  let runs = 0;
  const breaches = [];
  for (let i = 0; i < 4000; i++) {
    const mt = Math.floor(rnd() * 5) - 1; // -1..3 (out-of-range included)
    const nClaims = Math.floor(rnd() * 4);
    const claims = [];
    for (let c = 0; c < nClaims; c++) {
      const claim = { "@id": `urn:c${c}`, "@type": "t", requiredTrustTier: Math.floor(rnd() * 5) - 1 };
      // randomly attach (bogus, empty) binding material
      if (rnd() < 0.5) claim[bindingMembers[Math.floor(rnd() * 3)]] = {};
      claims.push(claim);
    }
    const max = Math.floor(rnd() * 5); // 0..4 (out-of-range included)
    const frag = evaluateTrustTiers({ requiredTrustTier: mt, claims }, { maxSupportedTrustTier: max });
    runs += 1;
    if (frag.effectiveTrustTier !== undefined && frag.effectiveTrustTier >= 1)
      breaches.push(`mt=${mt} max=${max} claims=${nClaims} → effTrustTier=${frag.effectiveTrustTier}`);
  }
  verdict(
    "AV-10",
    "manifest-only attacker (default provider) can NEVER reach effectiveTrustTier ≥ 1",
    breaches.length === 0,
    `${runs} random manifests (out-of-range tiers + bogus binding members) → effectiveTrustTier stayed in {undefined, 0} everywhere`,
    breaches.slice(0, 3).join(" | ")
  );
}

// AV-11 — with a HOSTILE provider returning random junk (incl. "verified"), across
// random manifests: effectiveTrustTier ≤ effective-max ALWAYS, every recorded status
// tier ≤ effective-max, and no relied/deferred claim sits below the manifest floor.
{
  const rnd = mulberry32(0xBADF00D);
  const junk = [BINDING_VERIFIED, BINDING_FAILED, BINDING_ABSENT, BINDING_PRESENT_UNVERIFIED, "bogus", "", null, undefined, 7, {}, "VERIFIED"];
  let runs = 0;
  const breaches = [];
  for (let i = 0; i < 4000; i++) {
    const mt = Math.floor(rnd() * 5) - 1;
    const nClaims = Math.floor(rnd() * 4);
    const claims = [];
    for (let c = 0; c < nClaims; c++) claims.push({ "@id": `urn:c${c}`, "@type": "t", requiredTrustTier: Math.floor(rnd() * 5) - 1, holderBinding: {} });
    const max = Math.floor(rnd() * 5);
    const effMax = effTier(max);
    const manifestFloor = effTier(mt);
    const frag = evaluateTrustTiers(
      { requiredTrustTier: mt, claims },
      { maxSupportedTrustTier: max, holderBindingStatusOf: () => junk[Math.floor(rnd() * junk.length)] }
    );
    runs += 1;
    if (frag.effectiveTrustTier !== undefined && frag.effectiveTrustTier > effMax)
      breaches.push(`mt=${mt} max=${max}: effTrustTier=${frag.effectiveTrustTier} > effMax=${effMax}`);
    for (const s of frag.claimStatuses) if (typeof s.tier === "number" && s.tier > effMax) breaches.push(`recorded claim tier ${s.tier} > effMax ${effMax}`);
    for (const d of frag.deferredClaims) if (d.tier < manifestFloor) breaches.push(`deferred claim tier ${d.tier} < manifest floor ${manifestFloor} (downgrade)`);
  }
  verdict(
    "AV-11",
    "hostile-provider fuzz: effectiveTrustTier ≤ capability; no claim relied below floor",
    breaches.length === 0,
    `${runs} random manifests × random hostile provider outputs — effectiveTrustTier and all recorded tiers stayed ≤ capability; every deferred claim ≥ its manifest floor`,
    breaches.slice(0, 3).join(" | ")
  );
}

// AV-12 — OUT-OF-RANGE capability injection: an operator/attacker who sets
// maxSupportedTrustTier to an out-of-range value must NOT gain wider acceptance — the
// value coerces fail-closed to 0, so even a Tier-1 claim is unsupported.
{
  const oor = [5, 99, -1, 3.5, "3", "high", true, {}, [3], Infinity, NaN, null];
  const leaks = [];
  for (const max of oor) {
    const frag = evaluateTrustTiers(
      { requiredTrustTier: 0, claims: [{ "@id": "urn:c", "@type": "t", requiredTrustTier: 3, holderBinding: {} }] },
      { maxSupportedTrustTier: max, holderBindingStatusOf: () => BINDING_VERIFIED }
    );
    // A Tier-3 claim must be recorded unsupported (effMax coerced to 0), never accepted.
    const accepted = frag.deferredClaims.length > 0 || (frag.effectiveTrustTier ?? 0) > 0 || frag.verdict === "accepted";
    const boundaryTier = frag.claimStatuses[0]?.tier;
    if (accepted || boundaryTier !== 0) leaks.push(`max=${describe(max)} → verdict=${frag.verdict} tier=${boundaryTier} eff=${frag.effectiveTrustTier}`);
  }
  verdict(
    "AV-12",
    "out-of-range maxSupportedTrustTier fails closed to 0 (no widened acceptance)",
    leaks.length === 0,
    `${oor.length} out-of-range capability values — each coerced to 0; the Tier-3 claim recorded unsupported at boundary 0, never accepted`,
    leaks.slice(0, 3).join(" | ")
  );
}

// AV-14 — bilateral negotiated floor: a hostile counterparty passing invalid/negative/
// out-of-range tiers must NOT be able to drag the negotiated floor BELOW the honest
// party's requirement (the floor is a raise-only max()).
{
  const honest = 2;
  const hostile = [-1, -5, 0.5, 1.9, "0", "1", NaN, Infinity, {}, [1], null, undefined, false, 99];
  const leaks = [];
  for (const h of hostile) {
    const floor = negotiateBilateralFloor(honest, h);
    if (floor < honest) leaks.push(`hostile=${describe(h)} → negotiated floor ${floor} < honest ${honest}`);
  }
  // and the reverse: a hostile party can only RAISE it (stricter), never below honest.
  const raiseOnly = negotiateBilateralFloor(honest, 3) === 3;
  verdict(
    "AV-14",
    "hostile counterparty cannot drag the bilateral floor below the honest party's requirement",
    leaks.length === 0 && raiseOnly,
    `${hostile.length} hostile payloads — negotiated floor never dropped below honest requirement ${honest}; a valid higher tier raises it (max semantics)`,
    leaks.slice(0, 3).join(" | ")
  );
}

// AV-15 — prototype-pollution / inherited-member probe: a manifest/claim carrying
// __proto__ or an inherited requiredTrustTier must not pollute Object.prototype nor let
// an inherited low tier be relied below the floor.
{
  const polluter = JSON.parse('{"requiredTrustTier": 1, "claims": [{"@id": "urn:c", "@type": "t", "__proto__": {"requiredTrustTier": 0}, "requiredTrustTier": 1}]}');
  const frag = evaluateTrustTiers(polluter, { maxSupportedTrustTier: 1, holderBindingStatusOf: () => BINDING_PRESENT_UNVERIFIED });
  const noPollution = ({}).requiredTrustTier === undefined && ({}).polluted === undefined;
  const reliedTier = frag.deferredClaims[0]?.tier ?? frag.claimStatuses[0]?.tier;
  const notBelowFloor = reliedTier === undefined || reliedTier >= 1;
  verdict(
    "AV-15",
    "prototype/inherited tier members neither pollute Object.prototype nor drop reliance below floor",
    noPollution && notBelowFloor,
    `Object.prototype unpolluted after evaluating a __proto__-bearing manifest; claim reliance tier=${reliedTier} (>= floor 1)`,
    `prototype pollution detected OR inherited tier dropped reliance below the floor (tier ${reliedTier})`
  );
}

// ===========================================================================
// SUMMARY
// ===========================================================================
console.log(`\n=== ATTACK SUMMARY: ${RESISTED} RESISTED, ${VULNERABLE} ⚠️VULNERABLE ===`);
if (VULNERABLE === 0) {
  console.log(
    "VERDICT: SOUND. Every elevation vector was RESISTED. The raise-only floor merge\n" +
      "(max), the capability-before-cap decision order, the fail-closed provider clamp,\n" +
      "and the capability-bounded effectiveTrustTier hold under TOCTOU getters, type\n" +
      "coercion, empty-binding decoys, re-evaluation, multi-claim compose, forged\n" +
      "\"verified\" outputs, out-of-range capability injection, and 8000 fuzzed manifests.\n" +
      "Two INFORMATIONAL (non-elevating) notes recorded: AV-04 seam (empty-binding verdict\n" +
      "shift; deferred≠trusted) and AV-07 fidelity (holderBindingStatus last-write-wins)."
  );
} else {
  console.error("VERDICT: VULNERABILITIES FOUND — see findings above. Trust elevation is possible.");
  for (const f of findings) console.error(`  - ${f.id} ${f.name}: ${f.repro}`);
}
process.exit(VULNERABLE === 0 ? 0 : 1);
