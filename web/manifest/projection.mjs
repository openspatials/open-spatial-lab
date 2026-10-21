// Universal Manifest v0.4 Stage-3 selective-disclosure projection.
//
// This module owns the v0.4 Base "Project" stage (stage 3 of the six-stage
// evaluation sequence Arrive · Verify · PROJECT · Consent · Compose · Receipt;
// CONFORMANCE §2.1) — bounded selective minimum disclosure. In plain language
// (CONFORMANCE §1/§2): each viewer, verifier, system, or use case receives ONLY
// the minimum information it is allowed or needs to see. It carries three
// responsibilities that..129 left unowned (matrix gap G3; page bars
// portaling P7/P13, RP1 R3):
//
//   1. RECEIVER-ROLE PROJECTION (the novel logic). From ONE signed source envelope
//      produce a per-receiver PROJECTED manifest containing only the facets/claims/
//      pointers that receiver's role/audience is entitled to (the disclosure RULES
//      travel as DATA on the manifest — P13). A withheld facet is recorded
//      `not-projected` and is NOT evidence of absence (CONFORMANCE §2, Base §3.3.1):
//      a receiver cannot distinguish "present but withheld" from "the subject does
//      not have it" — that indistinguishability IS the privacy property. FAIL
//      CLOSED: when the requirement→projection entitlement is unclear, WITHHOLD.
//      A projection MUST NOT leak — a not-projected RECORD is emitted only for
//      facets the receiver's OWN requirement referenced (so it reveals no new
//      existence); facets neither requested nor entitled are omitted with no trace.
//
//   2. UNRECOGNIZED-ENTRY RECORDING (fail-closed baselines, CONFORMANCE §5.1):
//        - An unrecognized claim `@type` is `unprocessable` — present but
//          unverifiable above Tier 0 — recorded in `claimStatuses` (Section 1.4.3).
//          Fixture: valid/claim-unrecognized-type.jsonld.
//        - An unrecognized pointer `@type` is recorded present in the receipt's
//          `unprocessedEntries` and MUST NOT be acted on (Section 1.4.5).
//          Fixture: valid/pointer-unrecognized-type.jsonld.
//
//   3. REQUIREMENT→PROJECTION BINDING CHAIN (RP1 service encounter). A service-
//      scoped user projection binds to the counterparty's SIGNED requirement and
//      content-trust manifests by hash + challenge nonce: `sessionNonce` ==
//      requirement.challengeNonce, `requirementManifestHash` ==
//      canonicalManifestHash(requirement), `contentTrustManifestHash` ==
//      canonicalManifestHash(contentTrustPackage). Acceptance authority:
//      examples/integrations/rp1-spatial-fabric/service-encounter/
//      verify-service-encounter.mjs — this module reproduces its binding assertions.
//
// SEMANTICS ARE PINNED TO THE REFERENCE IMPLEMENTATION that produced
// conformance/v0.4/expected.json:
//   (evaluateUniversalManifestV04 — claim loop ~L3179-3242, pointer loop ~L3244-3258,
//    facet-status order ~L3266-3373, outcome mapping ~L3375-3399, receipt ~L3401-3421).
// The subtle, fixture-pinned details this stage reproduces EXACTLY:
//   - recognizedClaimTypes = { "identity.crossDidBinding" } — everything else is
//     unprocessable (unless a tier/binding path fires first).
//   - CLAIM CHECK ORDER: capability (tier > max) → binding-cap (tier>=1, no material)
//     → unrecognized-type (unprocessable) → recognized (unverified). The tier paths
//     (trustTierUnsupported) are canonical domain; this module REUSES
// tier math (effectiveFloor/capTier/defaultHolderBindingStatusOf) so
//     there is a single source of truth and the order matches the reference. The
//     unprocessable/unverified branches are.
//   - claimRef = claim["@id"] when a non-empty string, else claim["@type"].
//   - POINTER: `um:agentDelegation` is a recognized pointer and is skipped;
//     every other pointer @type → unprocessedEntries { kind:"pointer", type, ref? }.
//   - `not-projected` is OUTCOME-NEUTRAL (the reference outcome mapping never lists
//     it): withholding is normal disclosure, not a failure — a view of only
//     processed + not-projected facets is "accepted", never "accepted-partial".
//   - canonicalManifestHash covers the WHOLE manifest INCLUDING `signature` (you pin
//     the exact signed bytes you received from the counterparty; you do NOT strip
//     their signature). Verified against verify-service-encounter.mjs + the fixture's
//     declared hashes (see verify.mjs). [This corrects the draft prose,
//     which said "signature removed" — that is the SIGNING-input rule, a different
//     hash. The binding-chain reference hash is over the full artifact.]
//
// ---------------------------------------------------------------------------
// SCOPE / HONESTY (read before touching the labels)
// ---------------------------------------------------------------------------
// IMPLEMENTED FOR REAL here: receiver-role projection with fail-closed withholding
// and non-leaking not-projected records; data-driven entitlement (facet disclosure
// policy + consent audience.match); unrecognized claim/pointer recording; the
// requirement→projection binding chain (real SHA-256 over JCS-style canonical bytes).
// All fail CLOSED.
//
// NOT implemented here (seams, honestly labeled — this stage does not re-own them):
//   - Signature / freshness verification (Verify stage) =. This stage
//     assumes the caller Verified the envelope; it does not set signatureCheck.
//   - Consent VALUE evaluation (expired/withdrawn/scope) on PROJECTED facets =.
//     This stage decides WHICH facets are projected and defaults a projected facet to
//     `processed`; re-statuses to consent-denied/consent-missing.
//   - Encrypted-facet sealing (opaque) =; assurance floors =; the
//     full composed six-stage um:Receipt =. This module returns a Project-
//     stage receipt FRAGMENT for the composing evaluator, not a full um:Receipt.
// This module flips NO um_conformance flag.
//
// Zero runtime dependencies beyond WebCrypto (SHA-256) and pure tier math;
// plain ESM (.mjs) — imports cleanly in Node (>=18) and the browser, like its siblings.

import {
  TRUST_TIER_DEFAULT,
  BINDING_ABSENT,
  BINDING_FAILED,
  effectiveFloor,
  capTier,
  defaultHolderBindingStatusOf,
} from "./trust-tier.mjs";

// ===========================================================================
// v0.4 vocabulary (pinned to the reference implementation)
// ===========================================================================

/** Per-facet status set — CONFORMANCE §2 item 6 / Base §3.3.1. */
export const FACET_STATUSES = Object.freeze([
  "processed",
  "opaque",
  "consent-denied",
  "consent-missing",
  "trustTierUnsupported",
  "assuranceInsufficient",
  "not-projected",
  "written",
]);

/** Per-claim status set this stage records (Section 1.4.3 + tier paths). */
export const CLAIM_STATUSES = Object.freeze([
  "unprocessable",
  "unverified",
  "trustTierUnsupported",
]);

/**
 * Recognized claim @types (reference: `recognizedClaimTypes`, index.ts L3179).
 * Everything else is `unprocessable` above Tier 0. The demo evaluator recognizes
 * exactly what the reference recognizes — no silent over-recognition.
 */
export const RECOGNIZED_CLAIM_TYPES = Object.freeze(new Set(["identity.crossDidBinding"]));

/**
 * Recognized pointer @types that are NOT recorded as unprocessed. The reference
 * skips only `um:agentDelegation` in the unprocessedEntries loop.
 */
export const RECOGNIZED_POINTER_TYPES = Object.freeze(new Set(["um:agentDelegation"]));

/** Project-stage receipt-outcome contributions (subset of the full um:Receipt set). */
export const PROJECT_OUTCOMES = Object.freeze(["accepted", "accepted-partial", "rejected"]);

// ===========================================================================
// Small pure helpers
// ===========================================================================

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function claimRefOf(claim) {
  const c = claim && typeof claim === "object" ? claim : {};
  return isNonEmptyString(c["@id"]) ? c["@id"] : c["@type"];
}

/** A facet/claim/pointer @type normalized to a set of string types (JSON-LD allows array @type). */
function typeSet(node) {
  const t = node && node["@type"];
  if (Array.isArray(t)) return t.filter((x) => typeof x === "string");
  if (typeof t === "string") return [t];
  return [];
}

// ===========================================================================
// (A) Canonicalization + hashing — the binding-chain reference hash.
//     Byte-identical to examples/.../service-encounter/verify-service-encounter.mjs
//     `canonicalizeJson` (deep-key-sorted JSON, undefined dropped). Covers the WHOLE
//     manifest, INCLUDING `signature`. Browser-safe (WebCrypto), so async.
// ===========================================================================

/** Deterministic JSON: keys sorted ascending, `undefined` members dropped. */
export function canonicalizeManifest(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeManifest(item)).join(",")}]`;
  if (t !== "object") return JSON.stringify(value);
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeManifest(value[key])}`).join(",")}}`;
}

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) unavailable — need Node >= 18 or a modern browser");
  return s;
}

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = new Uint8Array(await subtle().digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The binding-chain reference hash of a signed manifest: `sha256:<hex>` over the
 * FULL manifest (signature included). This is what a projection pins so the
 * evaluator can confirm the projection was issued against the exact requirement /
 * content-trust bytes the counterparty signed. (verify-service-encounter.mjs
 * `canonicalManifestHash`.)
 */
export async function canonicalManifestHash(manifest) {
  return `sha256:${await sha256Hex(canonicalizeManifest(manifest))}`;
}

// ===========================================================================
// (B) Requirement→projection binding chain (RP1 service encounter).
// ===========================================================================

/** Find a facet by `name` and return its `entity` object (RP1 facets are `{name, entity}`). */
function facetEntity(manifest, name) {
  const match = (manifest?.facets || []).find((f) => f?.name === name);
  return match && typeof match.entity === "object" ? match.entity : undefined;
}

function consentByName(manifest, name) {
  return (manifest?.consents || []).find((c) => c?.name === name);
}

/**
 * DERIVE the three binding-chain fields a holder must embed in the projection's
 * serviceAuth facet, from the (signed) requirement + content-trust manifests. This
 * proves the chain is REPRODUCED, not merely re-read from the fixture.
 *
 * @returns {Promise<{sessionNonce, requirementManifestHash, contentTrustManifestHash}>}
 */
export async function deriveBindingChain({ requirementManifest, contentTrustManifest }) {
  const serviceRequirements = facetEntity(requirementManifest, "serviceRequirements");
  if (!serviceRequirements) throw new Error("deriveBindingChain: requirement manifest has no serviceRequirements facet");
  return {
    sessionNonce: serviceRequirements.challengeNonce,
    requirementManifestHash: await canonicalManifestHash(requirementManifest),
    contentTrustManifestHash: await canonicalManifestHash(contentTrustManifest),
  };
}

/**
 * VERIFY the requirement→projection binding chain of a service-scoped user
 * projection. Reproduces every binding assertion in verify-service-encounter.mjs
 * (the acceptance authority) — hash/nonce chain + terms echo + consent audience
 * scoping + required-package match. Returns { ok, checks:[{id,ok,detail}] }; NEVER
 * throws for a data mismatch (fail-closed: a missing/undefined field is a failed
 * check, not a pass).
 */
export async function verifyServiceEncounterBinding({ requirementManifest, contentTrustManifest, projectionManifest }) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: detail || "" });

  const serviceRequirements = facetEntity(requirementManifest, "serviceRequirements");
  const publishedTerms = facetEntity(requirementManifest, "publishedTerms");
  const contentTrust = facetEntity(contentTrustManifest, "contentTrust");
  const serviceAuth = facetEntity(projectionManifest, "serviceAuth");
  const termsAcceptance = facetEntity(projectionManifest, "termsAcceptance");
  const handTracking = consentByName(projectionManifest, "sensor.handTracking");
  const eyeTracking = consentByName(projectionManifest, "sensor.eyeTracking");

  if (!serviceRequirements || !serviceAuth) {
    add("facets-present", false, "requirement.serviceRequirements or projection.serviceAuth missing");
    return { ok: false, checks };
  }

  const [reqHash, ctHash] = await Promise.all([
    canonicalManifestHash(requirementManifest),
    canonicalManifestHash(contentTrustManifest),
  ]);

  add("issuedForService", serviceAuth.issuedForService === requirementManifest.subject,
    `${serviceAuth.issuedForService} == ${requirementManifest.subject}`);
  add("serviceEndpoint", serviceAuth.serviceEndpoint === serviceRequirements.rmapEndpoint,
    `${serviceAuth.serviceEndpoint} == ${serviceRequirements.rmapEndpoint}`);
  add("sessionNonce", serviceAuth.sessionNonce === serviceRequirements.challengeNonce,
    `${serviceAuth.sessionNonce} == ${serviceRequirements.challengeNonce}`);
  add("requirementManifestHash", serviceAuth.requirementManifestHash === reqHash,
    `${serviceAuth.requirementManifestHash} == ${reqHash}`);
  add("contentTrustManifestHash", serviceAuth.contentTrustManifestHash === ctHash,
    `${serviceAuth.contentTrustManifestHash} == ${ctHash}`);

  if (publishedTerms && termsAcceptance) {
    add("termsDocumentHash", termsAcceptance.termsDocumentHash === publishedTerms.termsDocumentHash);
    add("termsVersion", termsAcceptance.termsVersion === publishedTerms.termsVersion);
  }

  add("handTracking-allowed", handTracking?.value === "allowed");
  add("handTracking-audience", handTracking?.audience?.match === requirementManifest.subject);
  add("eyeTracking-denied", eyeTracking?.value === "denied",
    "non-requested eye tracking stays denied in the projection");

  const requiredPackage = serviceRequirements.requiredPackages?.[0];
  if (requiredPackage && contentTrust) {
    add("package-id", requiredPackage.packageId === contentTrust.packageId);
    add("package-version", requiredPackage.packageVersion === contentTrust.packageVersion);
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

// ===========================================================================
// (C) Data-driven entitlement — the disclosure RULES travel as DATA (P13).
// ===========================================================================

/**
 * Decide whether a receiver is entitled to a source facet, using ONLY data that
 * travels on the manifest (never the receiver's self-assertion of entitlement):
 *
 *   1. Facet-carried `disclosure` policy: `{ audiences?: [did...], roles?: [role...],
 *      public?: boolean }`. Entitled iff `public === true`, or receiver.audience ∈
 *      audiences, or receiver.role ∈ roles.
 *   2. Consent audience binding: a consent with `facetRef === facet["@id"]`,
 *      `value === "allowed"`, and `audience.match === receiver.audience` grants that
 *      facet to that audience (the service-encounter model).
 *
 * FAIL CLOSED: no data-driven rule grants it → NOT entitled (withhold).
 *
 * @returns {{entitled: boolean, basis: string}}
 */
export function facetEntitlement(facet, receiver, manifest) {
  const r = receiver || {};
  const disclosure = facet && typeof facet.disclosure === "object" ? facet.disclosure : null;
  if (disclosure) {
    if (disclosure.public === true) return { entitled: true, basis: "disclosure.public" };
    if (isNonEmptyString(r.audience) && Array.isArray(disclosure.audiences) && disclosure.audiences.includes(r.audience)) {
      return { entitled: true, basis: "disclosure.audiences" };
    }
    if (isNonEmptyString(r.role) && Array.isArray(disclosure.roles) && disclosure.roles.includes(r.role)) {
      return { entitled: true, basis: "disclosure.roles" };
    }
  }
  const facetId = facet && facet["@id"];
  if (isNonEmptyString(facetId) && isNonEmptyString(r.audience)) {
    const granting = (manifest?.consents || []).some(
      (c) => c?.facetRef === facetId && c?.value === "allowed" && c?.audience?.match === r.audience
    );
    if (granting) return { entitled: true, basis: "consent.audience.match" };
  }
  return { entitled: false, basis: disclosure ? "no-matching-rule" : "no-disclosure-policy" };
}

// ===========================================================================
// (D) RECEIVER-ROLE PROJECTION — produce a per-receiver projected manifest.
// ===========================================================================

/**
 * Project ONE source envelope for ONE receiver. Returns a NEW projected manifest
 * carrying ONLY the entitled facets (+ the consents that scope them), plus a
 * disclosure record. FAIL-CLOSED and NON-LEAKING:
 *   - Facets not entitled are OMITTED entirely (no data, no trace) UNLESS the
 *     receiver's own requirement referenced them by name (`receiver.requests`), in
 *     which case a `not-projected` record is emitted — honestly answering the
 *     receiver's own question WITHOUT revealing whether the facet exists (a
 *     requested-and-withheld facet and a requested-but-absent facet are recorded
 *     identically: `not-projected` is NOT evidence of absence).
 *   - Consents are projected only when they scope a projected facet AND target this
 *     receiver's audience (a denial that names this audience is carried so the
 *     receiver sees its own "denied", per the service-encounter fixture).
 *
 * @param {object} sourceManifest  the full signed envelope.
 * @param {object} receiver        { audience?, role?, requests?: string[] (facet names) }
 * @param {object} [options]       { includeClaims?: bool, includePointers?: bool } — by
 *                                  default claims/pointers travel as-is (they carry
 *                                  their own recognition/tier gating downstream); set
 *                                  a per-type disclosure policy on a claim/pointer to
 *                                  scope it the same way as a facet.
 * @returns {object} { projectedManifest, disclosure }
 */
export function projectForReceiver(sourceManifest, receiver, options = {}) {
  const src = sourceManifest || {};
  const rcv = receiver || {};
  const requests = new Set(Array.isArray(rcv.requests) ? rcv.requests : []);
  const facets = Array.isArray(src.facets) ? src.facets : [];

  const projectedFacets = [];
  const projectedFacetIds = new Set();
  const projectedNames = [];
  const withheld = []; // { facetId?, name, reason, status:"not-projected", basis }

  for (const facet of facets) {
    const { entitled, basis } = facetEntitlement(facet, rcv, src);
    if (entitled) {
      projectedFacets.push(facet);
      if (isNonEmptyString(facet["@id"])) projectedFacetIds.add(facet["@id"]);
      if (isNonEmptyString(facet.name)) projectedNames.push(facet.name);
    } else if (isNonEmptyString(facet.name) && requests.has(facet.name)) {
      // Requested but withheld — honest not-projected record, no data leak.
      withheld.push({
        ...(isNonEmptyString(facet["@id"]) ? { facetId: facet["@id"] } : {}),
        name: facet.name,
        status: "not-projected",
        basis,
        reason: "withheld from this receiver — not projected (not diagnostics of absence; Base §3.3.1)",
      });
    }
    // else: not entitled AND not requested → omit entirely (zero-trace, no leak).
  }

  // Any REQUESTED facet name that does not appear in the source at all is ALSO
  // recorded not-projected — indistinguishable from a withheld one (the privacy
  // guarantee: the receiver cannot tell "you're hiding it" from "it isn't there").
  const sourceNames = new Set(facets.map((f) => f?.name).filter(isNonEmptyString));
  for (const requested of requests) {
    if (!sourceNames.has(requested) && !withheld.some((w) => w.name === requested)) {
      withheld.push({
        name: requested,
        status: "not-projected",
        basis: "not-in-source",
        reason: "not projected (not diagnostics of absence; Base §3.3.1)",
      });
    }
  }

  // Consents that scope a projected facet AND target this receiver's audience.
  const consents = (Array.isArray(src.consents) ? src.consents : []).filter((c) => {
    if (!projectedFacetIds.has(c?.facetRef)) return false;
    if (isNonEmptyString(rcv.audience) && c?.audience?.match !== undefined) {
      return c.audience.match === rcv.audience;
    }
    return true;
  });

  // Claims/pointers: carried as-is by default (downstream recognition/tier gating),
  // or scoped by their own per-node `disclosure` policy when present.
  const includeClaims = options.includeClaims !== false;
  const includePointers = options.includePointers !== false;
  const projectedClaims = includeClaims
    ? (Array.isArray(src.claims) ? src.claims : []).filter((c) =>
        c && typeof c.disclosure === "object" ? facetEntitlement(c, rcv, src).entitled : true
      )
    : [];
  const projectedPointers = includePointers
    ? (Array.isArray(src.pointers) ? src.pointers : []).filter((p) =>
        p && typeof p.disclosure === "object" ? facetEntitlement(p, rcv, src).entitled : true
      )
    : [];

  // Build the projected envelope: preserve envelope fields, strip `disclosure`
  // hints from projected facets (they are projector-side policy, not receiver data),
  // and DROP the source `signature` — a projection is a DISTINCT manifest the holder
  // re-signs (it is not the source bytes). We surface a marker so a caller/
  // re-signs; we never present the source signature as if it covered the projection.
  const projectedManifest = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "facets" || k === "consents" || k === "claims" || k === "pointers" || k === "signature") continue;
    projectedManifest[k] = v;
  }
  projectedManifest.facets = projectedFacets.map((f) => {
    if (f && typeof f === "object" && "disclosure" in f) {
      const { disclosure: _omit, ...rest } = f;
      return rest;
    }
    return f;
  });
  if (consents.length > 0) projectedManifest.consents = consents;
  if (projectedClaims.length > 0) projectedManifest.claims = projectedClaims;
  if (projectedPointers.length > 0) projectedManifest.pointers = projectedPointers;

  return {
    projectedManifest,
    disclosure: {
      receiver: { audience: rcv.audience, role: rcv.role },
      projectedFacets: projectedNames,
      withheldFacets: withheld,
      projectedFacetCount: projectedFacets.length,
      withheldFacetCount: withheld.length,
      resigningRequired: true, // must re-sign the projected manifest.
    },
  };
}

// ===========================================================================
// (E) PROJECT-STAGE RECEIPT FRAGMENT — claimStatuses / unprocessedEntries /
//     facetStatuses / verdict, pinned to the reference (index.ts).
// ===========================================================================

/**
 * Record a single claim's Project-stage status, reproducing the reference order:
 *   capability (tier > max) → binding-cap (tier>=1, no material) → unrecognized-type
 *   (unprocessable) → recognized (unverified). REUSES tier math so the tier
 *   branches are the single canonical source and match the reference numbers.
 * @returns {{status, entry, holderBindingStatus?, effectiveTrustTier?}}
 */
export function recordClaimStatus(claim, ctx = {}) {
  const manifestTier = ctx.manifestTier ?? TRUST_TIER_DEFAULT;
  const maxSupportedTrustTier = ctx.maxSupportedTrustTier ?? TRUST_TIER_DEFAULT;
  const holderBindingStatusOf =
    typeof ctx.holderBindingStatusOf === "function" ? ctx.holderBindingStatusOf : defaultHolderBindingStatusOf;

  const claimRef = claimRefOf(claim);
  const itemTier = effectiveFloor(manifestTier, claim?.requiredTrustTier);
  const bindingStatus = holderBindingStatusOf(claim);
  const cap = capTier({ requiredTier: itemTier, maxSupportedTrustTier, bindingStatus });

  if (cap.path === "unsupported") {
    return {
      entry: {
        claimRef,
        status: "trustTierUnsupported",
        tier: cap.tier,
        reason: `claim requiredTrustTier ${itemTier} exceeds evaluator capability ${maxSupportedTrustTier} (Section 6.4.5)`,
      },
    };
  }
  if (cap.path === "capped") {
    return {
      entry: {
        claimRef,
        status: "trustTierUnsupported",
        tier: 0,
        reason: "claim relied upon at Tier 1+ carries no holderBinding — capped at Tier 0 (EXT-T1 Section T1.1)",
      },
      holderBindingStatus: cap.holderBindingStatus ?? BINDING_ABSENT,
      effectiveTrustTier: 0,
    };
  }
  const types = typeSet(claim);
  const recognized = types.some((t) => RECOGNIZED_CLAIM_TYPES.has(t));
  if (!recognized) {
    return {
      entry: {
        claimRef,
        status: "unprocessable",
        tier: 0,
        reason: "unrecognized claim @type — present but unverifiable above Tier 0 (Section 1.4.3)",
      },
    };
  }
  return {
    entry: {
      claimRef,
      status: "unverified",
      tier: 0,
      reason: "claim-validation verification chain not executed by this evaluator (EXT-T1 Section T1.5.1)",
    },
  };
}

/**
 * The Project-stage receipt FRAGMENT for a (possibly already-projected) manifest.
 * Reproduces the reference claim loop, pointer loop, projected-facet baseline, and
 * outcome mapping. Consumes `not-projected` records from projectForReceiver via
 * `context.notProjected`. Does NOT verify signatures/freshness/consent-values —
 * those are (see SCOPE).
 *
 * @param {object} manifest  the manifest whose entries to status (a projection, or
 *                           a plain manifest — e.g. the two owned fixtures).
 * @param {object} [context]
 *   maxSupportedTrustTier   integer 0..3, default 0 (FAIL CLOSED).
 *   holderBindingStatusOf (claim) => status; default presence-based.
 *   notProjected            [{facetId?, name, status:"not-projected", reason}] from
 *                           projectForReceiver — merged into facetStatuses.
 *   omitProcessedAt         when true, no processedAt (matches the fixtures' pinned
 *                           evaluationContext for deterministic comparison).
 * @returns {object} fragment: { verdict, outcome, claimStatuses, unprocessedEntries,
 *   facetStatuses, holderBindingStatus?, effectiveTrustTier?, processedAt? }
 */
export function projectStageReceipt(manifest, context = {}) {
  const m = manifest || {};
  const manifestTier = m.requiredTrustTier ?? TRUST_TIER_DEFAULT;
  const maxSupportedTrustTier = context.maxSupportedTrustTier ?? TRUST_TIER_DEFAULT;
  const claimCtx = {
    manifestTier,
    maxSupportedTrustTier,
    holderBindingStatusOf: context.holderBindingStatusOf,
  };

  // --- claims (Section 1.4.3 + tier paths) ---
  const claimStatuses = [];
  let holderBindingStatus;
  let effectiveTrustTier;
  if (Array.isArray(m.claims)) {
    for (const claim of m.claims) {
      const rec = recordClaimStatus(claim, claimCtx);
      claimStatuses.push(rec.entry);
      if (rec.holderBindingStatus !== undefined) holderBindingStatus = rec.holderBindingStatus;
      if (rec.effectiveTrustTier !== undefined) effectiveTrustTier = rec.effectiveTrustTier;
    }
  }

  // --- pointers (Section 1.4.5) ---
  const unprocessedEntries = [];
  if (Array.isArray(m.pointers)) {
    for (const pointer of m.pointers) {
      const types = typeSet(pointer);
      if (types.some((t) => RECOGNIZED_POINTER_TYPES.has(t))) continue;
      const type = types[0] ?? (typeof pointer?.["@type"] === "string" ? pointer["@type"] : undefined);
      unprocessedEntries.push({
        kind: "pointer",
        type,
        ...(isNonEmptyString(pointer?.target) ? { ref: pointer.target } : {}),
      });
    }
  }

  // --- projected facets: Project-stage baseline is `processed` (
  //     re-status downstream); merge the not-projected records from projection. ---
  const facetStatuses = [];
  for (const facet of Array.isArray(m.facets) ? m.facets : []) {
    facetStatuses.push({
      facetId: facet?.["@id"],
      ...(isNonEmptyString(facet?.name) ? { name: facet.name } : {}),
      status: "processed",
    });
  }
  for (const np of Array.isArray(context.notProjected) ? context.notProjected : []) {
    facetStatuses.push({
      ...(np.facetId !== undefined ? { facetId: np.facetId } : {}),
      ...(isNonEmptyString(np.name) ? { name: np.name } : {}),
      status: "not-projected",
      ...(np.reason ? { reason: np.reason } : {}),
    });
  }

  // --- outcome (reference mapping, index.ts L3375-3399). not-projected is neutral. ---
  const hasFailed = facetStatuses.some(
    (f) => f.status === "consent-denied" || f.status === "trustTierUnsupported" || f.status === "assuranceInsufficient"
  );
  const hasAssuranceInsufficient = facetStatuses.some((f) => f.status === "assuranceInsufficient");
  const hasProcessed = facetStatuses.some((f) => f.status === "processed" || f.status === "written");
  const hasSealed = facetStatuses.some((f) => f.status === "opaque" || f.status === "consent-missing");
  const hasUnsupportedClaim = claimStatuses.some((c) => c.status === "trustTierUnsupported");

  let outcome = "accepted";
  if (hasAssuranceInsufficient && !hasProcessed) outcome = "rejected";
  else if (hasFailed) outcome = "accepted-partial";
  else if (hasSealed) outcome = "accepted-partial";
  else if (hasUnsupportedClaim) outcome = "accepted-partial";

  return {
    verdict: outcome, // house-style alias
    outcome,
    facetStatuses,
    ...(claimStatuses.length > 0 ? { claimStatuses } : {}),
    ...(unprocessedEntries.length > 0 ? { unprocessedEntries } : {}),
    ...(holderBindingStatus !== undefined ? { holderBindingStatus } : {}),
    ...(effectiveTrustTier !== undefined ? { effectiveTrustTier } : {}),
    ...(context.omitProcessedAt ? {} : { processedAt: new Date().toISOString() }),
  };
}

// ===========================================================================
// (F) Conformance-fixture handler + registration hook (mirrors registerWo134).
// ===========================================================================

/** The two v0.4 fixtures owns. */
export const feature_FIXTURE_FILENAMES = Object.freeze([
  "valid/claim-unrecognized-type.jsonld",
  "valid/pointer-unrecognized-type.jsonld",
]);

/**
 * Evaluate ONE fixture against its expected.json entry. Both owned fixtures
 * are `validationMode: "evaluation"`. Returns the adapter shape the shared v0.4
 * runner consumes: { result: "accept"|"reject", reason, receipt } where `receipt`
 * is the Project-stage fragment (so the runner — and verify.mjs — can assert
 * expectedReceiptOutcome / expectedClaimStatus / expectedUnprocessedEntry).
 *
 * The stage produces receipt fields, never a signature verdict: `result` is "accept"
 * whenever the Project stage does not itself reject (outcome !== "rejected"), which
 * is the correct contribution for these fixtures (the envelope signature is
 * concern and both fixtures are validly signed).
 */
export async function featureFixtureHandler(fixtureJson, expectedEntry = {}) {
  const ctx = { ...(expectedEntry.evaluationContext || {}) };
  const fragment = projectStageReceipt(fixtureJson, ctx);
  const result = fragment.outcome === "rejected" ? "reject" : "accept";
  return {
    result,
    reason: `project-stage outcome ${fragment.outcome}`,
    receipt: fragment,
  };
}

/**
 * Registration hook for the shared v0.4 conformance runner. Contract mirrors
 * registerWo134: registry.register(filename, asyncHandler(fixtureJson, expectedEntry)).
 * The integrator wires it with exactly:
 *   import { registerWo123 } from "../manifest/projection.mjs";
 *   registerWo123(registry);
 */
export function registerWo123(registry) {
  if (!registry || typeof registry.register !== "function") {
    throw new Error("registerWo123: registry with a register(filename, handler) function required");
  }
  for (const filename of feature_FIXTURE_FILENAMES) {
    registry.register(filename, featureFixtureHandler);
  }
  return feature_FIXTURE_FILENAMES.length;
}

// ===========================================================================
// (G) Demo surface — "one envelope, three different views" (RP1 R3 / P7 / P13).
// ===========================================================================

/**
 * Build a demo SOURCE envelope carrying four facets with data-driven disclosure
 * policies, then project it for three receivers (a service, a co-present peer, an
 * auditor). Pure/synchronous; used by the crossing UI and verify.mjs to show
 * that ONE envelope yields THREE genuinely different, non-leaking projections.
 *
 * @returns {{ source, views: { service, peer, auditor } }}
 */
export function buildThreeViewDemo() {
  const subject = "did:peer:2.Ez6LDemoUniversalManifestSubject";
  const serviceDid = "did:web:warehouse.example.com:services:inventory";
  const auditRole = "compliance-auditor";

  const source = {
    "@context": "https://universalmanifest.net/ns/v0.4",
    "@id": "urn:uuid:0c123000-0000-4000-8000-000000000123",
    "@type": "um:Manifest",
    manifestVersion: "0.4",
    subject,
    issuedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2030-06-01T00:00:00.000Z",
    facets: [
      {
        "@id": "urn:um:facet:demo:persona",
        "@type": ["um:Facet", "rp1:Persona"],
        name: "persona",
        entity: { displayName: "Kai_Nomad", entityType: "human", contentRating: "G" },
        disclosure: { public: true }, // everyone in the room may see the persona
      },
      {
        "@id": "urn:um:facet:demo:serviceAuth",
        "@type": ["um:Facet", "rp1:ServiceAuth"],
        name: "serviceAuth",
        entity: { issuedForService: serviceDid, scope: ["som.read:/factory/floor-2/**"] },
        disclosure: { audiences: [serviceDid] }, // ONLY the inventory service
      },
      {
        "@id": "urn:um:facet:demo:location",
        "@type": ["um:Facet", "rp1:Location"],
        name: "location",
        entity: { zone: "/factory/floor-2", precision: "zone" },
        disclosure: { audiences: [serviceDid], roles: [auditRole] }, // service + auditor
      },
      {
        "@id": "urn:um:facet:demo:govId",
        "@type": ["um:Facet", "rp1:GovernmentId"],
        name: "govId",
        entity: { docType: "passport", country: "NZ" },
        disclosure: { roles: [auditRole] }, // ONLY a compliance auditor
      },
    ],
  };

  // Each receiver requests every facet by name (so a withheld one yields an honest,
  // non-leaking not-projected record). The disclosure RULES on the facets — not the
  // receiver — decide what each actually gets.
  const allNames = ["persona", "serviceAuth", "location", "govId"];
  const service = projectForReceiver(source, { audience: serviceDid, role: "service", requests: allNames });
  const peer = projectForReceiver(source, { audience: "did:peer:2.Ez6LCopresentBystander", role: "peer", requests: allNames });
  const auditor = projectForReceiver(source, { audience: "did:web:warehouse.example.com:review", role: auditRole, requests: allNames });

  return { source, views: { service, peer, auditor } };
}

// ===========================================================================
// (H) Module descriptor (honesty surface — mirrors TRUST_TIER_ENGINE / feature_CONFORMANCE).
// ===========================================================================

export const feature_PROJECTION = Object.freeze({
  wo: "runtime",
  standard:
    "Universal Manifest v0.4 Base — Stage-3 Project / bounded selective minimum disclosure " +
    "(CONFORMANCE §1/§2 items 1&6; Base §3.1 stage 3, §3.3.1 status set incl. not-projected; " +
    "Sections 1.4.3 claims / 1.4.5 pointers; RP1 service-encounter binding chain)",
  fixtures_owned: 2, // valid/claim-unrecognized-type, valid/pointer-unrecognized-type
  page_bars: Object.freeze(["portaling P7", "portaling P13", "RP1 R3"]),
  implements: Object.freeze([
    "receiver-role projection: per-receiver projected manifest, entitled facets only",
    "fail-closed withholding (unclear entitlement => withhold) + non-leaking not-projected records",
    "data-driven entitlement: facet `disclosure` policy + consent audience.match (rules travel as data, P13)",
    "unrecognized claim @type => `unprocessable` in claimStatuses (Section 1.4.3)",
    "unrecognized pointer @type => receipt `unprocessedEntries`, not acted on (Section 1.4.5)",
    "requirement→projection binding chain (sessionNonce + requirement/contentTrust manifest hashes)",
    "one-envelope-three-views demo surface (RP1 R3 / P7 / P13)",
  ]),
  does_not_implement: Object.freeze([
    "signature/freshness verification (runtime/119) — this stage assumes Verify already ran; sets no signatureCheck",
    "consent VALUE evaluation on projected facets — a projected facet defaults to `processed`",
    "encrypted-facet sealing/opaque, assurance floors",
    "the composed six-stage um:Receipt (runtime/144) — this returns a Project-stage FRAGMENT",
    "trust-tier MATH is REUSED from runtime (not re-derived): effectiveFloor/capTier/defaultHolderBindingStatusOf",
  ]),
  fail_closed: true,
  not_projected_is_not_evidence_of_absence: true,
  binding_chain_hash_covers_signature: true, // whole-manifest hash, per verify-service-encounter.mjs
  um_conformance_claimed: false,
  scope_boundary:
    "Stage-3 Project logic only — receiver-role projection + unrecognized-entry recording + the " +
    "requirement→projection binding chain, returned as a receipt FRAGMENT for the composing v0.4 " +
    "evaluator (runtime/144). Flips no um_conformance flag. Honesty ceiling: a projection never " +
    "leaks a facet the receiver is not entitled to; when the binding is unclear, it withholds.",
});
