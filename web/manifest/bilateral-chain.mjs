// BEGIN — v0.4 bilateral session + paired-receipt correlation
// + THE receipt hash-chain (EXT-OPT O3.1/O4 PREVIEW; Base §4 field surface).
//
// ============================================================================
// THIS MODULE IS THE SINGLE OWNER OF THE RECEIPT HASH-CHAIN (matrix G6).
// ============================================================================
// receipt hub RESERVED the chain surface (seq/prevHash/chainId on the
// canonical um:Receipt; seq/prevHash/sealSignature nulls on the receipt-chain
// facet) and NEVER computes prevHash. THIS module is the only computer of
// prevHash and the only filler of those reserved fields. RP1
// departure-manifest seal (R11) MUST reuse this chain — do not build a second
// one (see feature_BILATERAL_CONFORMANCE.chain_shape for the reuse contract).
//
// External source of truth (READ-ONLY):
//   spec/v0.4/CONFORMANCE.md §4      bilateral participant MUSTs: both present,
//                                    both evaluate, negotiated floor = max of
//                                    both parties' requiredTrustTier (distinct
//                                    from each side's recorded effectiveTrustTier),
//                                    fail closed for Sybil-critical actions,
//                                    in-session receipts carry exchangeId+evaluatorId.
//   spec/v0.4/schema.json            $defs.bilateralSession (@type const, sessionId,
//                                    exchangeId, exactly 2 participants {did, role
//                                    initiator|responder}, initiatedAt, expiresAt,
//                                    state enum).
//   docs/spec-v0.4/ext-opt.html O4   session object + STRICTLY-FORWARD lifecycle
//                                    initiated → manifests-exchanged →
//                                    receipts-exchanged → completed, with
//                                    "expired" enterable from any ACTIVE state
//                                    (TTL elapsed WITHOUT "completed"); session
//                                    operations MUST be rejected after expiresAt;
//                                    receipts already exchanged remain valid
//                                    records. O4.1 security: sessionId/exchangeId
//                                    each ≥128-bit entropy, MUST NOT encode party
//                                    identifiers. O4.3: paired receipts share the
//                                    session's exchangeId, MUST carry evaluatorId,
//                                    SHOULD be signed (tamper-evident).
//   docs/spec-v0.4/ext-opt.html O3.1 chain integrity: chainId (for a bilateral
//                                    session MUST equal the sessionId), seq
//                                    monotonic gapless from 0, prevHash = hash of
//                                    the immediately preceding receipt; verifiers
//                                    MUST confirm continuity + linkage, report a
//                                    broken link, and treat the chain AFTER the
//                                    break as unverified. Archived-chain rule:
//                                    link expiry is NOT a broken link.
//
// ★ HASH CONVENTION (empirically pinned — do not conflate):
//   chain hashes = canonicalManifestHash() from projection.mjs — deep-key-
//   sorted JSON over the WHOLE prior receipt manifest INCLUDING its `signature`,
//   emitted as "sha256:<64 hex>". This is DISTINCT from the JCS SIGNING-INPUT
//   exclusion set {signature, postQuantumSignature, presentationProof} used by
// to sign each link. Genesis link: prevHash: null (house pin; the
//   O3.1 letter says "omitted" and multibase/multihash — deltas declared in
//   feature_BILATERAL_CONFORMANCE.spec_letter_deltas, PREVIEW surface).
//
// Chain-link fields (seq/prevHash/chainId) are written BEFORE Profile A signing,
// so they sit INSIDE each link's signed payload: tampering a link's chain fields
// breaks that link's own signature, and tampering ANY prior link's content
// breaks the recomputed prevHash of its successor. A re-signed forgery (attacker
// substitutes a self-consistent link) is still caught by the NEXT link's
// prevHash recompute — that is what the hash chain adds over per-link signatures.
//
// HONESTY CEILING: chain integrity is REAL (recompute + compare; the verifier
// proves tamper-breaks-verify). The session object + hash-chaining are EXT-OPT
// O3/O4 PREVIEW and labeled so; the Base §4 exchangeId/evaluatorId fields are
// NOT preview. effectiveTrustTier values consumed by the floor gate are the
// OUTPUT of evaluation — this module enforces the negotiated floor,
// it does not verify tiers itself. NO um_conformance flag is flipped here.
// Grade-2 design-stage members are not emitted.
//
// Browser-safe (WebCrypto only); Node >= 18 for the verify.mjs driver.

import {
  stampBilateral,
  mintExchangeId,
  correlateDualReceipts,
  reserveChainLinkFields,
  promoteReceiptToManifest,
  buildDepartureManifestDraft,
  validateReceiptShape,
} from "./receipt-hub.mjs";
import { canonicalManifestHash } from "./projection.mjs"; // THE chain hash (whole doc INCL signature)
import { negotiateBilateralFloor } from "./trust-tier.mjs"; // single source of tier-floor math
import { attachSignatureProfileA, verifyManifestProfileA, sign, verify } from "../signing/um-signature-profile-a.mjs";
// READ-ONLY use of the signing lib (did:key is offline byte-math) — bind a
// link's SIGNING key to its claimed evaluatorId (V2). No signing code is modified.
import { publicKeyToDidKey } from "../signing/did.mjs";
import { spkiToRawPublicKey } from "../signing/ed25519.mjs";
import { base64ToBytes } from "../signing/codecs.mjs";

export { mintExchangeId }; // re-export: the demo mints exchange tokens through ONE surface

// ===========================================================================
// 0) SMALL LOCAL HELPERS (module-local; the hub does not export its internals)
// ===========================================================================

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isIsoDateTime(v) {
  return isNonEmptyString(v) && Number.isFinite(Date.parse(v));
}
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let hex = "";
  for (const b of buf) hex += b.toString(16).padStart(2, "0");
  return hex;
}
function utf8ToHex(str) {
  const bytes = new TextEncoder().encode(str);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// ===========================================================================
// 1) THE SESSION OBJECT — um:BilateralSession (EXT-OPT O4.1, PREVIEW)
// ===========================================================================

/** The O4.2 lifecycle states, in strictly-forward order (+ the TTL terminal). */
export const SESSION_STATES = Object.freeze([
  "initiated",
  "manifests-exchanged",
  "receipts-exchanged",
  "completed",
  "expired",
]);
const FORWARD_STATES = SESSION_STATES.slice(0, 4); // the strictly-forward ladder
/** States from which "expired" may be entered (O4.2: TTL elapsed WITHOUT "completed"). */
export const ACTIVE_SESSION_STATES = Object.freeze(["initiated", "manifests-exchanged", "receipts-exchanged"]);

/** Mint a session correlation token: 128 bits of crypto entropy, encoding NO
 *  party identifiers (O4.1 security). Sibling of the hub's mintExchangeId(). */
export function mintSessionId() {
  return `urn:um:session:${randomHex(16)}`;
}

/**
 * Structural assert for um:BilateralSession — mirrors the reference
 * `assertBilateralSessionV04` (packages/universal-manifest/src/index.ts) check
 * for check: wrong @type rejected, sessionId/exchangeId required, EXACTLY two
 * participants each {did, role ∈ initiator|responder}, RFC 3339 initiatedAt/
 * expiresAt, state in the 5-value enum. Throws on the first violation.
 */
export function assertBilateralSessionShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session must be an object");
  if (value["@type"] !== "um:BilateralSession") throw new Error("Session @type must be um:BilateralSession");
  if (!isNonEmptyString(value.sessionId)) throw new Error("Session missing sessionId");
  if (!isNonEmptyString(value.exchangeId)) throw new Error("Session missing exchangeId");
  if (!Array.isArray(value.participants) || value.participants.length !== 2) {
    throw new Error("Session participants must be an array of exactly 2 entries");
  }
  for (const p of value.participants) {
    if (!p || typeof p !== "object") throw new Error("Session participant must be an object");
    if (!isNonEmptyString(p.did)) throw new Error("Session participant missing did");
    if (p.role !== "initiator" && p.role !== "responder") {
      throw new Error("Session participant role must be initiator or responder");
    }
  }
  if (!isIsoDateTime(value.initiatedAt)) throw new Error("session.initiatedAt must be an ISO 8601 date-time");
  if (!isIsoDateTime(value.expiresAt)) throw new Error("session.expiresAt must be an ISO 8601 date-time");
  if (!SESSION_STATES.includes(value.state)) {
    throw new Error(`Session state must be one of ${SESSION_STATES.join("|")}`);
  }
}

/** Non-throwing wrapper over assertBilateralSessionShape → { valid, errors }. */
export function validateBilateralSessionShape(session) {
  try {
    assertBilateralSessionShape(session);
    return { valid: true, errors: [] };
  } catch (e) {
    return { valid: false, errors: [e.message] };
  }
}

/**
 * Create a real um:BilateralSession for one crossing (one exchange round per
 * session — a new exchange between the same parties is a NEW session with new
 * sessionId/exchangeId, O4.1). The two correlation tokens are crypto-random
 * ≥128-bit and are LINTED against both party identifiers at mint time (fail
 * closed — a token that embeds a party id never leaves this constructor).
 * Visitor = initiator, world = responder (the demo's crossing roles).
 */
export function createBilateralSession({ initiatorDid, responderDid, initiatedAt, ttlSeconds = 3600, sessionId, exchangeId } = {}) {
  if (!isNonEmptyString(initiatorDid) || !isNonEmptyString(responderDid)) {
    throw new Error("createBilateralSession: initiatorDid and responderDid are required");
  }
  if (initiatorDid === responderDid) {
    throw new Error("createBilateralSession: the two participants must be DISTINCT parties");
  }
  if (!(Number.isFinite(ttlSeconds) && ttlSeconds > 0)) {
    throw new Error("createBilateralSession: ttlSeconds must be a positive number");
  }
  const initiated = isIsoDateTime(initiatedAt) ? initiatedAt : new Date().toISOString();
  const session = {
    "@type": "um:BilateralSession",
    sessionId: isNonEmptyString(sessionId) ? sessionId : mintSessionId(),
    exchangeId: isNonEmptyString(exchangeId) ? exchangeId : mintExchangeId(),
    participants: [
      { did: initiatorDid, role: "initiator" },
      { did: responderDid, role: "responder" },
    ],
    initiatedAt: initiated,
    expiresAt: new Date(Date.parse(initiated) + ttlSeconds * 1000).toISOString(),
    state: "initiated",
  };
  if (session.sessionId === session.exchangeId) {
    throw new Error("createBilateralSession: sessionId and exchangeId must be distinct correlation tokens");
  }
  for (const [kind, token] of [["session", session.sessionId], ["exchange", session.exchangeId]]) {
    const lint = lintCorrelationToken(token, { kind, partyIds: [initiatorDid, responderDid] });
    if (!lint.ok) {
      throw new Error(`createBilateralSession: ${kind} token failed the correlation-token lint — ${lint.problems.join("; ")}`);
    }
  }
  assertBilateralSessionShape(session);
  return session;
}

// ===========================================================================
// 2) LIFECYCLE — strictly forward, TTL fail-closed (EXT-OPT O4.2)
// ===========================================================================

/** O4.1: after expiresAt the session IS "expired". Auto-marks an active session
 *  whose TTL elapsed; completed/expired are left untouched. Returns the session. */
export function expireSessionIfPastTtl(session, { now } = {}) {
  assertBilateralSessionShape(session);
  const nowMs = isIsoDateTime(now) ? Date.parse(now) : Date.now();
  if (ACTIVE_SESSION_STATES.includes(session.state) && nowMs > Date.parse(session.expiresAt)) {
    session.state = "expired";
  }
  return session;
}

/**
 * Advance the session lifecycle STRICTLY FORWARD (O4.2): initiated →
 * manifests-exchanged → receipts-exchanged → completed, one step at a time.
 * Backward moves, skips, and transitions out of a terminal state THROW.
 * "expired" may be entered only from an ACTIVE state (TTL elapsed WITHOUT
 * "completed") — never from "completed". Any non-expired transition attempted
 * after expiresAt is rejected fail-closed (and the session auto-expires).
 */
export function advanceSessionState(session, next, { now } = {}) {
  assertBilateralSessionShape(session);
  if (!SESSION_STATES.includes(next)) {
    throw new Error(`advanceSessionState: unknown state "${next}" (must be one of ${SESSION_STATES.join("|")})`);
  }
  const before = session.state;
  expireSessionIfPastTtl(session, { now });
  if (session.state === "expired") {
    if (next === "expired") return session; // idempotent under TTL auto-expiry
    throw new Error(
      `advanceSessionState: session is expired (expiresAt ${session.expiresAt}) — "${next}" rejected fail-closed ` +
        `(O4.1: a participant MUST NOT perform session operations after expiresAt)`
    );
  }
  if (next === "expired") {
    if (!ACTIVE_SESSION_STATES.includes(session.state)) {
      throw new Error(
        `advanceSessionState: "expired" may only be entered from an active state (O4.2: TTL elapsed WITHOUT "completed"), not from "${session.state}"`
      );
    }
    session.state = "expired";
    return session;
  }
  const from = FORWARD_STATES.indexOf(session.state);
  const to = FORWARD_STATES.indexOf(next);
  if (from === -1) {
    throw new Error(`advanceSessionState: no transitions out of terminal state "${before}"`);
  }
  if (to !== from + 1) {
    throw new Error(
      `advanceSessionState: illegal transition "${session.state}" → "${next}" — the lifecycle is STRICTLY FORWARD ` +
        `(O4.2: ${FORWARD_STATES.join(" → ")}; no return to a previous state, no skipped stage)`
    );
  }
  session.state = next;
  return session;
}

/**
 * Fail-closed guard for SESSION OPERATIONS (O4.1: presenting/accepting a
 * manifest under the session, producing/accepting a receipt bearing its
 * exchangeId, the completion acknowledgment). Throws when the session is
 * expired (or past TTL — auto-expires first) or already completed. Receipts
 * already exchanged remain valid records (chain verification never consults
 * this guard — O3.1 archived-chain rule).
 */
export function assertSessionOperable(session, { now } = {}) {
  expireSessionIfPastTtl(session, { now });
  if (session.state === "expired") {
    throw new Error(
      "session operation rejected: session is expired (O4.1 fail-closed; already-exchanged receipts remain valid records)"
    );
  }
  if (session.state === "completed") {
    throw new Error(
      "session operation rejected: session already completed — one exchange round per session; start a NEW session with fresh sessionId/exchangeId (O4.1)"
    );
  }
  return session;
}

// ===========================================================================
// 3) CORRELATION-TOKEN LINT (EXT-OPT O4.1 security / v0.4 README)
// ===========================================================================

/**
 * Lint a bilateral correlation token (sessionId / exchangeId) against the O4.1
 * security rules: ≥128 bits of crypto entropy and NO party identifiers encoded.
 * This is a LINT, not an entropy proof — it structurally catches the real
 * failure classes:
 *   shape    — must be "urn:um:session:<hex>" / "urn:um:exchange:<hex>"
 *              (house token shape; lowercase hex).
 *   bits     — hex payload ≥ 32 chars (= 128 bits).
 *   diversity— ≥ 6 distinct nibbles (catches constants/counters; a 32-char
 *              crypto-random hex has < 1e-9 chance of failing this).
 *   runs     — no single-character run > 12 (catches zero-padded counters and
 *              timestamps that pass the diversity check).
 *   party ids— token must not contain any partyIds entry verbatim, its DID
 *              method-specific id, or its hex(UTF-8) encoding.
 * Returns { ok, problems: string[] }.
 */
export function lintCorrelationToken(token, { kind, partyIds = [] } = {}) {
  const problems = [];
  if (!isNonEmptyString(token)) return { ok: false, problems: ["token must be a non-empty string"] };

  const m = /^urn:um:(session|exchange):([0-9a-f]+)$/.exec(token);
  if (!m) {
    problems.push('shape: expected "urn:um:session:<hex>" or "urn:um:exchange:<hex>" (lowercase hex payload)');
  } else {
    if (kind !== undefined && m[1] !== kind) problems.push(`kind: expected a urn:um:${kind}:… token, got urn:um:${m[1]}:…`);
    const hex = m[2];
    if (hex.length < 32) problems.push(`entropy: hex payload is ${hex.length * 4} bits — below the 128-bit minimum (O4.1)`);
    const distinct = new Set(hex).size;
    if (distinct < 6) problems.push(`entropy: only ${distinct} distinct nibble values — constant/counter-like, not crypto-random`);
    let run = 1;
    let maxRun = 1;
    for (let i = 1; i < hex.length; i++) {
      run = hex[i] === hex[i - 1] ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
    }
    if (maxRun > 12) problems.push(`entropy: ${maxRun}-character repeat run — padded-counter/timestamp shape, not crypto-random`);
    // progression— reject arithmetic / counter-like nibble sequences that slip past
    //              diversity + runs (e.g. "0123…ef0123…ef": 16 distinct nibbles, no
    //              long run, yet fully predictable — every consecutive delta is +1
    //              mod 16). A CSPRNG token has ~uniform consecutive nibble deltas; a
    //              counter's deltas are near-constant. Flag when ONE delta dominates.
    //              (Minted mintExchangeId/mintSessionId tokens are crypto-random and
    //              never trip this: P(dominant ≥ 70% of 31 deltas) ≈ 1e-19.)
    if (hex.length >= 32) {
      const nibbles = [...hex].map((c) => parseInt(c, 16));
      const deltaCounts = new Map();
      for (let i = 1; i < nibbles.length; i++) {
        const d = (((nibbles[i] - nibbles[i - 1]) % 16) + 16) % 16;
        deltaCounts.set(d, (deltaCounts.get(d) ?? 0) + 1);
      }
      const totalDeltas = nibbles.length - 1;
      let dominant = 0;
      for (const c of deltaCounts.values()) if (c > dominant) dominant = c;
      if (totalDeltas > 0 && dominant / totalDeltas >= 0.7) {
        problems.push(
          `entropy: ${dominant}/${totalDeltas} consecutive-nibble deltas are identical — arithmetic/counter-like progression, not crypto-random`
        );
      }
    }
  }

  const low = token.toLowerCase();
  for (const id of partyIds) {
    if (!isNonEmptyString(id)) continue;
    const idLow = id.toLowerCase();
    const methodSpecific = idLow.startsWith("did:") ? idLow.split(":").slice(2).join(":") : idLow;
    if (low.includes(idLow)) {
      problems.push(`party identifier embedded: token contains "${id}" (O4.1: MUST NOT encode party identifiers)`);
    } else if (methodSpecific.length >= 6 && low.includes(methodSpecific)) {
      problems.push(`party identifier embedded: token contains the DID method-specific id of "${id}"`);
    } else if (low.includes(utf8ToHex(idLow))) {
      problems.push(`party identifier embedded (hex-encoded): token contains hex(UTF-8) of "${id}"`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ===========================================================================
// 4) NEGOTIATED FLOOR (CONFORMANCE §4 / Base §6.4.6 — reuses tier math)
// ===========================================================================

/**
 * The exchange-level tier floor: MAX of both parties' `requiredTrustTier`
 *. A NEGOTIATED FLOOR —
 * what the exchange demands — DISTINCT from the effectiveTrustTier each party
 * verifies and records in its own receipt. Asymmetric requirements are valid.
 */
export function negotiatedTierFloor(manifestA, manifestB) {
  return negotiateBilateralFloor(manifestA?.requiredTrustTier, manifestB?.requiredTrustTier);
}

/**
 * Enforce the negotiated floor over the tiers each party actually VERIFIED for
 * its counterparty (receipt.effectiveTrustTier — output; absent →
 * Tier 0, the fail-closed default). CONFORMANCE §4: for Sybil-critical actions
 * (the portal crossing IS one) parties MUST fail closed when the floor is not
 * satisfied; lower-risk actions MAY degrade to a restricted mode instead.
 * Returns { floor, satisfied, unsatisfied[], sybilCritical, action } with
 * action ∈ "proceed" | "fail-closed" | "restricted-mode".
 */
export function enforceExchangeFloor({ floor, verifiedTiers = {}, sybilCritical = true } = {}) {
  if (!(Number.isInteger(floor) && floor >= 0 && floor <= 3)) {
    throw new Error("enforceExchangeFloor: floor must be an integer 0..3 (use negotiatedTierFloor)");
  }
  const unsatisfied = Object.entries(verifiedTiers)
    .filter(([, tier]) => (Number.isInteger(tier) ? tier : 0) < floor)
    .map(([party]) => party);
  const satisfied = unsatisfied.length === 0;
  return {
    floor,
    satisfied,
    unsatisfied,
    sybilCritical,
    action: satisfied ? "proceed" : sybilCritical ? "fail-closed" : "restricted-mode",
  };
}

// ===========================================================================
// 5) PAIRED-RECEIPT CORRELATION (EXT-OPT O4.3 — hub primitives underneath)
// ===========================================================================

/**
 * Stamp BOTH parties' receipts with the session's exchangeId + each evaluator's
 * DID (Base §4 MUST; hub correlateDualReceipts underneath — distinct evaluators
 * enforced there) and advance the session to "receipts-exchanged". Receipts are
 * only produced after both manifests were presented, so the session must be in
 * "manifests-exchanged" and within TTL (fail closed otherwise).
 * receiptByInitiator = the initiator's evaluation OF the responder's manifest,
 * and vice versa. Returns { exchangeId, receipts }.
 */
export function pairSessionReceipts(session, receiptByInitiator, receiptByResponder, { now } = {}) {
  assertSessionOperable(session, { now });
  if (session.state !== "manifests-exchanged") {
    throw new Error(
      `pairSessionReceipts: receipts are produced after both manifests are presented — session is "${session.state}", expected "manifests-exchanged"`
    );
  }
  const initiator = session.participants.find((p) => p.role === "initiator");
  const responder = session.participants.find((p) => p.role === "responder");
  if (!initiator || !responder) throw new Error("pairSessionReceipts: session must carry one initiator and one responder");
  const out = correlateDualReceipts(receiptByInitiator, receiptByResponder, {
    exchangeId: session.exchangeId,
    evaluatorIdA: initiator.did,
    evaluatorIdB: responder.did,
  });
  advanceSessionState(session, "receipts-exchanged", { now });
  return out;
}

/**
 * Retrieval side of O4.3: pull the correlated PAIR for one exchange out of a
 * pile of receipts (the receipt UI's primitive). ok only when EXACTLY two
 * receipts share the exchangeId and carry DISTINCT evaluatorIds.
 */
export function correlateReceiptPair(receipts, exchangeId) {
  if (!isNonEmptyString(exchangeId)) throw new Error("correlateReceiptPair: exchangeId is required");
  const matches = (Array.isArray(receipts) ? receipts : []).filter((r) => r && r.exchangeId === exchangeId);
  const evaluators = new Set(matches.map((r) => r.evaluatorId));
  const ok = matches.length === 2 && evaluators.size === 2 && !evaluators.has(undefined);
  return {
    exchangeId,
    ok,
    found: matches.length,
    pair: ok ? matches : null,
    ...(ok
      ? {}
      : {
          problem:
            matches.length !== 2
              ? `expected exactly 2 receipts sharing ${exchangeId}, found ${matches.length}`
              : "the two receipts must carry DISTINCT evaluatorIds",
        }),
  };
}

// ===========================================================================
// 6) THE RECEIPT HASH-CHAIN (EXT-OPT O3.1 PREVIEW — the single chain, owned here)
// ===========================================================================

/**
 * Create the hash chain. Pass the um:BilateralSession for a bilateral chain —
 * chainId MUST then equal the sessionId (O3.1) — or { chainId } for a
 * non-session audit chain (RP1 departure-seal reuse path; a fresh
 * urn:um:chain:<hex128> is minted when omitted).
 */
export function createReceiptHashChain(source = {}) {
  let chainId;
  if (source && source["@type"] === "um:BilateralSession") {
    assertBilateralSessionShape(source);
    chainId = source.sessionId; // O3.1: for a bilateral session chainId MUST equal sessionId
  } else {
    chainId = isNonEmptyString(source.chainId) ? source.chainId : `urn:um:chain:${randomHex(16)}`;
  }
  return { chainId, createdAt: new Date().toISOString(), sealed: false, links: [] };
}

function isPromotedReceiptManifest(r) {
  const t = r?.["@type"];
  return Array.isArray(t) && t.includes("um:Manifest") && t.includes("um:Receipt") && isNonEmptyString(r?.["@context"]);
}

/**
 * The did:key a chain LINK's Profile A signature actually verifies under —
 * derived OFFLINE from the embedded SPKI public key (the exact key
 * verifyManifestProfileA uses; keyRef↔embedded consistency is already enforced
 * there, so the embedded key IS the verifying key). Falls back to a did:key
 * keyRef when no key is embedded. Returns null when no key material is
 * offline-derivable. Pure byte-math via the lib (READ-ONLY); used by V2
 * to bind the signer to the link's claimed evaluatorId.
 */
function signerDidKeyOfLink(link) {
  const sig = link?.signature;
  if (sig && typeof sig === "object" && typeof sig.publicKeySpkiB64 === "string" && sig.publicKeySpkiB64.length > 0) {
    return publicKeyToDidKey(spkiToRawPublicKey(base64ToBytes(sig.publicKeySpkiB64)));
  }
  if (sig && typeof sig === "object" && typeof sig.keyRef === "string" && sig.keyRef.startsWith("did:key:")) {
    return sig.keyRef.split("#")[0]; // a did:key keyRef encodes the verifying key
  }
  return null;
}

/**
 * Append ONE receipt as the next chain link. THE prevHash computation lives
 * here and nowhere else:
 *   seq      = links.length            (genesis 0; monotonic, gapless — O3.1)
 *   prevHash = null at genesis, else canonicalManifestHash(previous SIGNED
 *              link) — deep-key-sorted JSON over the WHOLE prior document
 *              INCLUDING its signature (the pinned house convention).
 *   chainId  = the chain's (= sessionId for bilateral chains).
 * The receipt (canonical hub shape, or an already-promoted UNSIGNED receipt
 * manifest) is promoted via the hub, the chain-link fields are written through
 * the hub's reserveChainLinkFields (write-validation), and the link is Profile
 * A signed — chain fields INSIDE the signed payload, so a tampered seq/prevHash
 * breaks the link's own signature. Signing is REQUIRED here (O4.3 SHOULD, but
 * this chain's tamper-evidence contract needs attributable links).
 * envelope = { subject: <evaluator DID>, issuedAt?, ttlSeconds?, id? }.
 */
export async function appendReceiptToChain(chain, receipt, { envelope = {}, privateKeyInput, keyRef } = {}) {
  if (!chain || !Array.isArray(chain.links)) throw new Error("appendReceiptToChain: a receipt hash chain is required");
  if (chain.sealed) throw new Error("appendReceiptToChain: chain is sealed (flushPolicy session-end) — no further links");
  if (!privateKeyInput) {
    throw new Error("appendReceiptToChain: privateKeyInput is required — chain links are Profile A signed (O4.3 tamper-diagnostics)");
  }
  const seq = chain.links.length;
  const prevHash = seq === 0 ? null : await canonicalManifestHash(chain.links[seq - 1]);

  let promoted;
  if (isPromotedReceiptManifest(receipt)) {
    if (receipt.signature) {
      throw new Error(
        "appendReceiptToChain: receipt is already signed — chain-link fields must sit INSIDE the signed payload; pass the unsigned receipt"
      );
    }
    promoted = { ...receipt };
  } else {
    promoted = promoteReceiptToManifest(receipt, envelope); // hub validates the canonical shape (fail closed)
  }
  reserveChainLinkFields(promoted, { seq, prevHash, chainId: chain.chainId }); // hub write-validation
  const signed = await attachSignatureProfileA(promoted, privateKeyInput, keyRef ? { keyRef } : {});
  chain.links.push(signed);
  return signed;
}

/** Seal the chain at session end (flushPolicy session-end): records headSeq and
 *  headHash = canonicalManifestHash(last link) — the anchor the departure-
 *  manifest facet seal pins. An empty chain cannot seal. */
export async function sealReceiptHashChain(chain, { at } = {}) {
  if (!chain || chain.sealed) throw new Error("sealReceiptHashChain: chain missing or already sealed");
  if (chain.links.length === 0) throw new Error("sealReceiptHashChain: cannot seal an empty chain");
  chain.sealed = true;
  chain.sealedAt = isIsoDateTime(at) ? at : new Date().toISOString();
  chain.headSeq = chain.links.length - 1;
  chain.headHash = await canonicalManifestHash(chain.links[chain.links.length - 1]);
  return chain;
}

/**
 * VERIFY the chain end-to-end — REAL recompute + compare, never stored-value
 * echo. Per link i: seq === i (gapless from 0), chainId matches (and
 * expectChainId when given — pass session.sessionId for bilateral chains),
 * prevHash === null at genesis else === canonicalManifestHash(link i-1)
 * RECOMPUTED over the as-stored prior link, canonical receipt shape holds
 * (hub contract), and the link's Profile A signature verifies (real Ed25519
 * over JCS). O3.1: the first broken link is reported (brokenAt) and every
 * link AFTER the break is marked "unverified" — not silently trusted. Link
 * TTL expiry is NOT re-gated here (archived-chain rule: expiry is not a
 * broken link; freshness governs acting on content, not chain verification).
 *
 * BOUND vs STRUCTURAL verification (hardening V1/V2). Passing ANY binding context
 * switches on the anchored checks the live "chain verified" path needs:
 *   expectChainId — chainId MUST equal it (O3.1); also flips on signer-binding.
 *   session       — an um:BilateralSession: derives expectChainId (its sessionId)
 *                   AND the authorized participant roster.
 *   participants  — an explicit array of authorized DIDs (evaluatorId ∈ roster).
 *   expectHead    — { headSeq, headHash } from a SIGNED external anchor to pin the
 *                   head against (authoritative tail-truncation guard, V1).
 * With NO binding context this is a STRUCTURAL check only (used by unit tamper
 * probes). A SEALED chain OBJECT is always head-bound against its own seal (V1).
 * Returns { valid, chainId, length, brokenAt, links[], errors[] }.
 */
export async function verifyReceiptChain(chainOrLinks, { expectChainId, session, participants, expectHead } = {}) {
  const links = Array.isArray(chainOrLinks) ? chainOrLinks : Array.isArray(chainOrLinks?.links) ? chainOrLinks.links : [];
  // The full chain OBJECT (when passed) carries the seal anchor (sealed/headSeq/
  // headHash) that a bare links[] array does not — V1 binds the verified head to it.
  const chainObject = !Array.isArray(chainOrLinks) && Array.isArray(chainOrLinks?.links) ? chainOrLinks : null;

  // BINDING CONTEXT. A caller that passes ANY of {expectChainId, session,
  // participants, expectHead} is asking for BOUND verification — the live "chain
  // verified" path, which additionally binds each link's signing key to its claimed
  // evaluatorId (V2). A bare verifyReceiptChain(links) with NO context is a
  // STRUCTURAL check only (used by unit tamper-probes) and keeps the pre-existing
  // "a re-signed forgery is caught by the successor's prevHash" behaviour.
  const authorizedDids = Array.isArray(participants)
    ? participants.filter(isNonEmptyString)
    : session && Array.isArray(session.participants)
      ? session.participants.map((p) => p?.did).filter(isNonEmptyString)
      : null;
  const authorizedSet = authorizedDids && authorizedDids.length ? new Set(authorizedDids) : null;
  const effectiveExpectChainId =
    expectChainId !== undefined ? expectChainId : session && isNonEmptyString(session.sessionId) ? session.sessionId : undefined;
  const bound =
    effectiveExpectChainId !== undefined || participants !== undefined || session !== undefined || expectHead !== undefined;

  const report = { valid: true, chainId: null, length: links.length, brokenAt: null, links: [], errors: [] };
  if (links.length === 0) {
    report.valid = false;
    report.errors.push("empty chain — nothing to verify");
    return report;
  }
  const chainId = links[0]?.chainId;
  report.chainId = chainId ?? null;
  if (!isNonEmptyString(chainId)) {
    report.valid = false;
    report.errors.push("genesis link carries no chainId");
  }
  if (effectiveExpectChainId !== undefined && chainId !== effectiveExpectChainId) {
    report.valid = false;
    report.errors.push(
      `chainId "${chainId}" does not equal expected "${effectiveExpectChainId}" (O3.1: a bilateral session's chainId MUST equal its sessionId)`
    );
  }

  // ---- V1: SEAL / HEAD-ANCHOR BINDING (tail-truncation + genesis-collapse guard).
  // Every truncated PREFIX of a sealed chain is internally consistent (gapless seq,
  // matching prevHash) so it has NO broken link — the only witness that a link was
  // dropped is the sealed head. Bind the verified head to a signed/sealed anchor:
  //   expectHead {headSeq, headHash} — an EXTERNAL anchor the caller pinned from a
  //     SIGNED surface (the departure-facet seal / a signed session record). This is
  //     the AUTHORITATIVE anchor (the raw object's own headSeq/headHash are attacker-
  //     mutable); the live crossing SHOULD pass it. Else fall back to
  //   the chain object's own seal (headSeq/headHash) — closes the in-object
  //     truncation where the seal metadata is left intact but a tail link is popped.
  const headAnchor =
    expectHead && typeof expectHead === "object"
      ? { headSeq: expectHead.headSeq, headHash: expectHead.headHash, source: "an external signed head anchor (expectHead)" }
      : chainObject && chainObject.sealed === true
        ? { headSeq: chainObject.headSeq, headHash: chainObject.headHash, source: "the chain seal (headSeq/headHash)" }
        : null;
  if (headAnchor) {
    const headIndex = links.length - 1;
    if (!Number.isInteger(headAnchor.headSeq) || headIndex !== headAnchor.headSeq) {
      report.valid = false;
      report.errors.push(
        `head mismatch: chain presents ${links.length} link(s) (head index ${headIndex}) but ${headAnchor.source} pins headSeq=${headAnchor.headSeq} — a truncated prefix / genesis-collapse is rejected fail-closed (V1)`
      );
    }
    const recomputedHead = await canonicalManifestHash(links[links.length - 1]);
    if (!isNonEmptyString(headAnchor.headHash) || recomputedHead !== headAnchor.headHash) {
      report.valid = false;
      report.errors.push(
        `head hash mismatch: recomputed head ${String(recomputedHead).slice(0, 20)}… ≠ anchored headHash ${String(headAnchor.headHash).slice(0, 20)}… — the presented head is not the sealed head (V1 fail-closed)`
      );
    }
  }

  let broken = false;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const row = { seq: link?.seq, status: "verified", problems: [] };
    if (broken) {
      row.status = "unverified";
      row.problems.push("after the break — treated as unverified (O3.1)");
      report.links.push(row);
      continue;
    }
    if (link?.seq !== i) row.problems.push(`seq ${link?.seq} — expected ${i} (monotonic, gapless, genesis 0)`);
    if (link?.chainId !== chainId) row.problems.push(`chainId "${link?.chainId}" differs from the chain's "${chainId}"`);
    if (i === 0) {
      if (link?.prevHash !== null) row.problems.push(`genesis prevHash must be null, got ${JSON.stringify(link?.prevHash)}`);
    } else {
      const recomputed = await canonicalManifestHash(links[i - 1]);
      if (link?.prevHash !== recomputed) {
        row.problems.push(
          `prevHash mismatch: stored ${String(link?.prevHash).slice(0, 20)}… ≠ recomputed ${recomputed.slice(0, 20)}… — the prior link was altered or this link was forged`
        );
      }
    }
    const shape = validateReceiptShape(link);
    if (!shape.valid) row.problems.push(`canonical receipt shape violated: ${shape.errors[0]}`);
    const sig = await verifyManifestProfileA(link);
    if (!sig.ok) row.problems.push(`link signature failed: ${sig.reason}`);

    if (row.problems.length > 0) {
      row.status = "broken";
      broken = true;
      report.brokenAt = i;
      report.valid = false;
      for (const p of row.problems) report.errors.push(`link ${i}: ${p}`);
    }
    report.links.push(row);
  }

  // ---- V2: SIGNER-KEY ↔ CLAIMED-IDENTITY BINDING (SECOND pass; BOUND mode only).
  // Runs ONLY when the structural pass above found NO break, so a re-signed link
  // with a GENUINE successor is still reported at that successor's prevHash break
  // (the classic "money check", brokenAt = successor) — this pass never moves that
  // report earlier. It catches the residual attack the structural pass CANNOT: a
  // WHOLE-tail re-sign under the victim's identity, where the attacker re-fixed
  // every prevHash so the chain is self-consistent and the ONLY remaining witness
  // is that the signing key does not belong to the claimed evaluatorId. For a
  // did:key evaluatorId the binding is OFFLINE (the key IS the id); non-did:key ids
  // (did:web, …) are not offline-derivable (a resolver is out of offline scope) and
  // are instead caught by the participant-membership check when a roster is given.
  if (!broken && bound) {
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const problems = [];
      const evaluatorId = link?.evaluatorId;
      if (isNonEmptyString(evaluatorId) && evaluatorId.startsWith("did:key:")) {
        let signerDid = null;
        try {
          signerDid = signerDidKeyOfLink(link);
        } catch {
          signerDid = null;
        }
        if (signerDid === null) {
          problems.push(
            `signer identity not offline-derivable, yet evaluatorId is the did:key ${evaluatorId.slice(0, 24)}… — cannot bind the signing key to the claimed evaluator (fail closed, V2)`
          );
        } else if (signerDid !== evaluatorId) {
          problems.push(
            `signer/evaluator mismatch: the signing key binds to ${signerDid.slice(0, 24)}… but the link claims evaluatorId ${evaluatorId.slice(0, 24)}… — a re-signed forgery under another party's identity (V2)`
          );
        }
      }
      if (authorizedSet && !(isNonEmptyString(evaluatorId) && authorizedSet.has(evaluatorId))) {
        problems.push(
          `evaluatorId ${String(evaluatorId).slice(0, 24)}… is not one of the authorized session participants (V2: evaluatorId ∈ session.participants)`
        );
      }
      if (problems.length > 0) {
        report.links[i].status = "broken";
        report.links[i].problems.push(...problems);
        report.brokenAt = i;
        report.valid = false;
        for (const p of problems) report.errors.push(`link ${i}: ${p}`);
        for (let j = i + 1; j < links.length; j++) {
          report.links[j].status = "unverified";
          report.links[j].problems.push("after the break — treated as unverified (O3.1)");
        }
        break;
      }
    }
  }
  return report;
}

// ===========================================================================
// 7) FILLING RESERVED SEAL FIELDS (P17 facet / R5+R11 departure seal)
// ===========================================================================

/**
 * Fill the receipt-chain facet's RESERVED hash-chain seal fields (left
 * entity.seq / entity.prevHash / entity.sealSignature null — this is the only
 * module that fills them):
 *   entity.seq          = the sealed hash chain's head seq,
 *   entity.prevHash     = the chain-head anchor (canonicalManifestHash of the
 *                         LAST chained receipt — recomputed, not copied),
 *   entity.sealSignature= Profile A signature over the facet entity's canonical
 *                         bytes (sealSignature member excluded) — real Ed25519,
 *                         so tampering any carried trace row breaks the seal.
 * The hash chain must be SEALED first (flushPolicy session-end tie-in).
 */
export async function fillChainSealFields(chainFacet, hashChain, { privateKeyInput, keyRef } = {}) {
  const entity = chainFacet?.entity;
  if (!entity || typeof entity !== "object") throw new Error("fillChainSealFields: a receipt-chain facet (hub buildReceiptChainFacet) is required");
  if (!hashChain?.sealed) throw new Error("fillChainSealFields: seal the receipt hash chain first (flushPolicy session-end)");
  if (!Array.isArray(hashChain.links) || hashChain.links.length === 0) throw new Error("fillChainSealFields: the hash chain has no links");
  if (!privateKeyInput) throw new Error("fillChainSealFields: privateKeyInput is required for the seal signature");

  entity.seq = hashChain.links.length - 1;
  entity.prevHash = await canonicalManifestHash(hashChain.links[hashChain.links.length - 1]);
  const payload = { ...entity };
  delete payload.sealSignature;
  const { signature, protected: prot } = await sign(payload, privateKeyInput, keyRef ? { keyRef } : {});
  entity.sealSignature = { ...prot, value: signature };
  return chainFacet;
}

/**
 * Verify a filled facet seal — REAL recompute: entity.seq equals the chain
 * head, entity.prevHash equals the RECOMPUTED chain-head hash, and the seal
 * signature verifies over the entity's canonical bytes (public key embedded in
 * the seal per Profile A). Pass the hash chain to pin against; omit it to
 * check only the signature. Returns { ok, errors }.
 */
export async function verifyChainSealFields(chainFacet, hashChain = undefined) {
  const errors = [];
  const entity = chainFacet?.entity;
  if (!entity || typeof entity !== "object") return { ok: false, errors: ["not a receipt-chain facet"] };
  if (!entity.sealSignature || typeof entity.sealSignature !== "object") errors.push("sealSignature is missing (reserved field not filled)");
  if (!Number.isInteger(entity.seq)) errors.push("seq is missing (reserved field not filled)");
  if (!/^sha256:[0-9a-f]{64}$/.test(String(entity.prevHash))) errors.push("prevHash is missing/malformed (reserved field not filled)");

  if (hashChain) {
    if (!hashChain.sealed) errors.push("hash chain is not sealed");
    else {
      const headSeq = hashChain.links.length - 1;
      if (entity.seq !== headSeq) errors.push(`seq ${entity.seq} ≠ chain head seq ${headSeq}`);
      const recomputed = await canonicalManifestHash(hashChain.links[hashChain.links.length - 1]);
      if (entity.prevHash !== recomputed) errors.push("prevHash does not match the RECOMPUTED chain-head hash");
    }
  }
  if (entity.sealSignature && typeof entity.sealSignature === "object") {
    const payload = { ...entity };
    delete payload.sealSignature;
    const ok = await verify(payload, entity.sealSignature);
    if (!ok) errors.push("seal signature does not verify over the facet entity's canonical bytes");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * R5/R11 — the SEALED departure manifest: the hub's departure draft (carrying
 * the sealed EVENT chain's trace rows), with the reserved facet seal fields
 * FILLED against the receipt HASH chain, Profile A signed. This is the
 * "chain … local-hashed and sealed into a departure manifest" surface the RP1
 * page narrates; reuses exactly this (no second chain).
 */
export async function buildSealedDepartureManifest({ eventChain, hashChain, subject, issuedAt, ttlSeconds, id, privateKeyInput, keyRef } = {}) {
  const draft = buildDepartureManifestDraft(eventChain, { subject, issuedAt, ttlSeconds, id }); // hub: event chain must be sealed
  await fillChainSealFields(draft.facets[0], hashChain, { privateKeyInput, keyRef });
  return attachSignatureProfileA(draft, privateKeyInput, keyRef ? { keyRef } : {});
}

// ===========================================================================
// 8) THE FULL CROSSING (P2) — both present, both evaluate, paired + chained
// ===========================================================================

/**
 * Conduct ONE bilateral exchange round end-to-end (the portal crossing):
 *   1. session created (or supplied) — visitor initiator, world responder;
 *   2. both manifests presented → "manifests-exchanged";
 *   3. both parties INDEPENDENTLY evaluate the other's manifest — via each
 *      side's evaluateCounterparty(manifest, {now, evaluatorId, session}) which
 *      MUST return a canonical hub receipt (validated here, fail closed). This
 *      module does NOT evaluate manifests itself — evaluation is the stage
 *      engines' job;
 *   4. negotiated floor = max of both requiredTrustTier, enforced over each
 *      side's RECORDED effectiveTrustTier — the crossing is Sybil-critical, so
 *      an unsatisfied floor FAILS CLOSED (admitted: false); receipts are still
 *      exchanged and chained (denials are audit-trail events too);
 *   5. receipts paired (shared exchangeId + per-evaluator evaluatorId) →
 *      "receipts-exchanged"; each signed by ITS evaluator's key and appended
 *      to THE single hash chain (chainId = sessionId);
 *   6. both acknowledgments (in-process transport) → "completed"; chain sealed
 *      (flushPolicy session-end).
 * Returns { session, exchangeId, floor, admission, admitted, receipts:
 * { byInitiator, byResponder }, chain }.
 */
export async function conductBilateralExchange({ initiator, responder, session, now, ttlSeconds = 3600, sybilCritical = true } = {}) {
  for (const [label, party] of [["initiator", initiator], ["responder", responder]]) {
    if (!party || !isNonEmptyString(party.did)) throw new Error(`conductBilateralExchange: ${label}.did is required`);
    if (!party.manifest || typeof party.manifest !== "object") throw new Error(`conductBilateralExchange: ${label}.manifest is required`);
    if (typeof party.evaluateCounterparty !== "function") {
      throw new Error(`conductBilateralExchange: ${label}.evaluateCounterparty(manifest, ctx) is required — this module does not evaluate manifests itself`);
    }
    if (!party.privateKeyInput) throw new Error(`conductBilateralExchange: ${label}.privateKeyInput is required (chain links are signed by their evaluator)`);
  }
  const at = isIsoDateTime(now) ? now : new Date().toISOString();
  const sess = session ?? createBilateralSession({ initiatorDid: initiator.did, responderDid: responder.did, initiatedAt: at, ttlSeconds });
  assertSessionOperable(sess, { now: at });

  // 2 — both parties present manifests (P2).
  advanceSessionState(sess, "manifests-exchanged", { now: at });

  // 3 — both parties independently evaluate the other's manifest.
  const receiptByInitiator = await initiator.evaluateCounterparty(responder.manifest, { now: at, evaluatorId: initiator.did, session: sess });
  const receiptByResponder = await responder.evaluateCounterparty(initiator.manifest, { now: at, evaluatorId: responder.did, session: sess });
  for (const [label, r] of [["initiator", receiptByInitiator], ["responder", receiptByResponder]]) {
    const shape = validateReceiptShape(r);
    if (!shape.valid) throw new Error(`conductBilateralExchange: ${label}'s receipt violates the canonical shape — ${shape.errors.join("; ")}`);
  }

  // 4 — negotiated floor over the RECORDED effectiveTrustTiers (fail closed).
  const floor = negotiatedTierFloor(initiator.manifest, responder.manifest);
  const admission = enforceExchangeFloor({
    floor,
    verifiedTiers: {
      // the tier each party VERIFIED for its counterparty (absent → Tier 0):
      responder: Number.isInteger(receiptByInitiator.effectiveTrustTier) ? receiptByInitiator.effectiveTrustTier : 0,
      initiator: Number.isInteger(receiptByResponder.effectiveTrustTier) ? receiptByResponder.effectiveTrustTier : 0,
    },
    sybilCritical,
  });

  // 5 — pair (shared exchangeId, per-evaluator evaluatorId) and CHAIN.
  pairSessionReceipts(sess, receiptByInitiator, receiptByResponder, { now: at });
  const chain = createReceiptHashChain(sess);
  const signedByInitiator = await appendReceiptToChain(chain, receiptByInitiator, {
    envelope: { subject: initiator.did, issuedAt: at, ttlSeconds },
    privateKeyInput: initiator.privateKeyInput,
    ...(initiator.keyRef ? { keyRef: initiator.keyRef } : {}),
  });
  const signedByResponder = await appendReceiptToChain(chain, receiptByResponder, {
    envelope: { subject: responder.did, issuedAt: at, ttlSeconds },
    privateKeyInput: responder.privateKeyInput,
    ...(responder.keyRef ? { keyRef: responder.keyRef } : {}),
  });

  // 6 — both acknowledgments (in-process transport binding) → completed; seal.
  advanceSessionState(sess, "completed", { now: at });
  await sealReceiptHashChain(chain, { at });

  return {
    session: sess,
    exchangeId: sess.exchangeId,
    floor,
    admission,
    admitted: admission.action === "proceed",
    receipts: { byInitiator: signedByInitiator, byResponder: signedByResponder },
    chain,
  };
}

// ===========================================================================
// 9) DEMO PANEL ROW + HONESTY DESCRIPTOR (PREVIEW labels in claim text)
// ===========================================================================

/** Compact read-only telemetry row for the API_EVENTS panel — carries the
 *  PREVIEW label so the UI states the conformance posture verbatim. */
export function bilateralPanelRecord(session, { floor, admission, chainReport } = {}) {
  assertBilateralSessionShape(session);
  return {
    kind: "um-bilateral-session",
    preview: "EXT-OPT O3/O4 PREVIEW (session object + receipt hash-chain); Base §4 exchangeId/evaluatorId fields are NOT preview",
    sessionId: session.sessionId,
    exchangeId: session.exchangeId,
    state: session.state,
    participants: session.participants.map((p) => `${p.role}: ${p.did}`),
    expiresAt: session.expiresAt,
    ...(floor !== undefined ? { negotiatedTierFloor: floor } : {}),
    ...(admission ? { admission: admission.action, floorSatisfied: admission.satisfied } : {}),
    ...(chainReport
      ? { chain: { chainId: chainReport.chainId, length: chainReport.length, valid: chainReport.valid, brokenAt: chainReport.brokenAt } }
      : {}),
    at: new Date().toISOString(),
  };
}

export const feature_BILATERAL_CONFORMANCE = Object.freeze({
  wo: "runtime",
  scoped_claim:
    "um:BilateralSession object (schema $defs.bilateralSession shape, strictly-forward O4.2 lifecycle, " +
    "TTL fail-closed) + paired-receipt correlation (shared exchangeId, per-evaluator evaluatorId) + THE " +
    "receipt hash-chain (seq gapless from 0, prevHash recompute-verified, chainId = sessionId, Profile A " +
    "signed links, tamper genuinely breaks verification) + the negotiated bilateral tier floor (runtime math, " +
    "Sybil-critical fail-closed)",
  preview_features: Object.freeze([
    "um:BilateralSession object + lifecycle — EXT-OPT O4 PREVIEW",
    "receipt hash-chaining seq/prevHash/chainId + facet seal — EXT-OPT O3.1/O4 PREVIEW (computed ONLY here)",
    "receipts-as-manifests chain links (@type [um:Manifest,um:Receipt]) — EXT-OPT O3 PREVIEW (hub shape)",
  ]),
  base_surface: Object.freeze([
    "exchangeId/evaluatorId on in-session receipts and the negotiated tier floor are Base §4 / CONFORMANCE §4 — NOT preview",
  ]),
  not_claimed: Object.freeze([
    "NO um_conformance flag is flipped by this module",
    "manifest evaluation itself (signature/freshness/consent/tier verification) is the stage engines' job — this module frames, correlates, and chains",
    "effectiveTrustTier values consumed by the floor gate are runtime/134 outputs, not verified here",
    "the completion acknowledgment uses the in-process transport binding (O4.4 transport independence — no network protocol claimed)",
    "sessionKeyAuthorization (O3.1 session-scoped signing keys) is not implemented — links are signed with each evaluator's key; noted as a privacy trade-off, not claimed",
  ]),
  spec_letter_deltas: Object.freeze([
    'prevHash encoding: house "sha256:<64 hex>" string (hub-validated), not multibase/multihash — O3.1 names the multihash encoding as an open wire-freeze input',
    "genesis prevHash: explicit null (house pin, hub-validated), where the O3.1 letter says omitted for seq 0",
    "chain hash preimage: canonicalManifestHash over the WHOLE prior receipt INCLUDING signature (pinned by runtime's binding-chain reference), where O3.1 says the prior receipt's canonical signing bytes",
  ]),
  chain_shape: Object.freeze({
    chain: "{ chainId, createdAt, sealed, sealedAt?, headSeq?, headHash?, links: [signed receipt manifests] }",
    link:
      '{ "@context", "@id", "@type":["um:Manifest","um:Receipt"], manifestVersion:"0.4", subject:<evaluator DID>, ' +
      "issuedAt, expiresAt, …canonical receipt members…, exchangeId, evaluatorId, seq, prevHash, chainId, signature } " +
      "— chain fields INSIDE the signed payload; prevHash(i) = canonicalManifestHash(link i-1)",
    reuse: "runtime: createReceiptHashChain({chainId}) | (session) → appendReceiptToChain → sealReceiptHashChain → verifyReceiptChain / fillChainSealFields / buildSealedDepartureManifest",
  }),
  hash_conventions: Object.freeze({
    chain: "canonicalManifestHash (runtime-projection.mjs): deep-key-sorted JSON over the WHOLE document INCLUDING signature",
    signing_input: "JCS RFC-8785 with {signature, postQuantumSignature, presentationProof} excluded (runtime/119)",
  }),
});

// END
