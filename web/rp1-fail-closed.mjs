// RP1 fail-closed traversal gate + journeys (journey-07 + J22).
//
// This module implements the FAIL-CLOSED integration edge the RP1 / MSF Spatial-Fabric
// integration doc requires (universalmanifest/integrations/rp1-spatial-fabric.md,
// §"What the primary sources now confirm" #6 + §Guardrails + §Integration checklist):
//
//   1. STALE ATTACHMENT => BLOCK. `rp1.attachmentIndex` freshness (`status: stale` or an
//      expired `expiresAt`) triggers the attachment policy's
//      `onFreshnessFailure: deny-child-scope-traversal` — the child scope MUST NOT open.
//   2. REVOKED/EXPIRED SESSION => NO REPLAY. An `rp1.sessionContext` pointer with
//      `status: revoked` (or already expired) MUST NOT be replayed or reused.
//   3. CONSENT-GATED CROSS-WORLD LINKAGE. An attachment naming
//      `consentRequired: [spatial.crossWorldLinking]` blocks the CROSS-scope link when that
//      consent is denied — the attachment stays `linkVisibility: local-only`.
//   4. CYCLE / REPEATED-MOUNT SAFETY. `cycleHandling: track-visited-scopes` +
//      `repeatedMountPolicy: single-mount-per-traversal` — a scope mounted once in a
//      traversal is REFUSED re-entry instead of traversing infinitely.
//   5. DEFAULT-DENY. On any unknown condition (missing policy/pointer/consent, unknown
//      status token, internal error) the gate DENIES. It never fails open.
//
// It CONSUMES the RP1 pointer/facet model (web/manifest/rp1-model.mjs): the gate
// evaluates the `rp1.*` pointers / `spatial.*` consents / `spatialFabricAttachmentPolicy`
// facet that buildRp1Section() emits (or that the v0.1 RP1 stubs carry directly — both
// shapes expose the same `name`/`url`/`status`/`observedAt`/`expiresAt` + `name`/`value`
// semantics). The input hooks (attachmentStatus / sessionContextStatus /
// crossWorldLinking) are consumed via demoModeToRp1Options() — never re-derived here.
//
// Every decision produces a RECEIPT: `status: "accepted"` (allow) or `status: "rejected"`
// (deny, with the fail-closed action + reasons) — the J22 "each fail-closed path produces
// a rejected/degraded receipt" evidence, and the object the crossing UI's visible demo
// mode renders.
//
// Verified (re-runnable, network-free) by web/rp1-fail-closed-verify.mjs against the
// journey-07 + J22 acceptance checklists and the three v0.1 RP1 stubs. This module flips
// NO um_conformance flag: the ONLY scoped flag it introduces is
// RP1_FAIL_CLOSED.fail_closed_conformance (see the descriptor below for its exact,
// narrow meaning).
//
// ZERO dependencies; pure data over plain objects; browser-safe (no Node built-ins) so the
// live crossing gate (web/live-adapter.js) and the Node harness share ONE implementation.

// ===========================================================================
// Scoped descriptor (the honesty object — mirrors UM_CONFORMANCE / IWPS_CONFORMANCE /
// RP1_MODEL). Machine-readable statement of EXACTLY what is and is not claimed.
// ===========================================================================

/** The demo modes the crossing UI can arm (the two fail-closed paths + off). */
export const RP1_FAIL_CLOSED_MODES = Object.freeze(["off", "stale-attachment", "revoked-session"]);

export const RP1_FAIL_CLOSED = Object.freeze({
  standard: "RP1 / MSF Spatial Fabric integration (non-normative) — fail-closed traversal gate",
  wo: "runtime",
  integration_doc:
    "universalmanifest/integrations/rp1-spatial-fabric.md (§Guardrails + §Integration checklist)",
  journeys: Object.freeze([
    "journey-07-rp1-spatial-fabric-projection",
    "J22-rp1-attachment-freshness-and-session-safety",
  ]),
  behaviors: Object.freeze({
    stale_attachment:
      "deny-child-scope-traversal (rp1.attachmentIndex status:stale OR expired expiresAt)",
    revoked_session: "deny-replay-and-reuse (rp1.sessionContext status:revoked/expired never replayed)",
    consent_gate:
      "spatial.crossWorldLinking denied => cross-scope link blocked (linkVisibility: local-only)",
    cycle_safety: "track-visited-scopes + single-mount-per-traversal (repeated mount refused)",
    unknown_condition: "default-deny (missing policy/pointer/consent or internal error never fails open)",
  }),
  // SCOPED flag — true means EXACTLY this and nothing more: the journey-07 + J22 acceptance
  // checklists and the three v0.1 RP1 stubs (baseline ACCEPTED; stale-attachment crossing
  // BLOCKED with deny-child-scope-traversal; revoked-session NOT replayed) pass in the
  // re-runnable, network-free harness web/rp1-fail-closed-verify.mjs, with each fail-closed
  // path producing a `rejected` receipt. The harness itself HARD-FAILS its honesty check if
  // any of those checks fail while this flag reads true — a fake flag cannot survive a run.
  // A reviewer re-runs the harness independently; if it does not fully pass, this flag
  // MUST go back to false (same flag-flip discipline as UM_CONFORMANCE / IWPS_CONFORMANCE).
  fail_closed_conformance: true,
  verified_by: "web/rp1-fail-closed-verify.mjs (node web/rp1-fail-closed-verify.mjs; exit 0 = all pass)",
  // What this flag does NOT claim — the honest boundary (these stay false):
  evaluator_conformance: false, // v0.4 six-stage evaluator receipt =; NOT claimed here
  v04_baseline: false, // no hostable v0.4 badge exists in the UM runner; NOT claimed here
  full_conformance: false, // the fail-closed lane is NOT the whole UM/RP1 conformance program
  um_conformance_unchanged: true, // proof_boundary.um_conformance stays the scoped object
  scope_boundary:
    "RP1 fail-closed TRAVERSAL GATE only: stale attachment => deny-child-scope-traversal; " +
    "revoked/expired session => no replay/reuse; denied spatial.crossWorldLinking => " +
    "cross-scope link blocked (local-only); cycle/repeated-mount safety; default-deny on " +
    "unknown conditions. Scoped to journey-07 + J22 + the three v0.1 RP1 stubs. NOT v0.4 " +
    "evaluator conformance, NOT full UM/RP1 conformance; um_conformance untouched.",
});

// RP1 vocabulary this gate evaluates (kept identical to constants; duplicated as
// plain strings here so this leaf module stays import-free and browser/Node portable).
const PTR_ATTACHMENT_INDEX = "rp1.attachmentIndex";
const PTR_SESSION_CONTEXT = "rp1.sessionContext";
const CONSENT_CROSS_WORLD = "spatial.crossWorldLinking";
const CONSENT_SESSION_REPLAY = "spatial.sessionReplay";
const FACET_ATTACHMENT_POLICY = "spatialFabricAttachmentPolicy";
const DENY_CHILD_SCOPE_TRAVERSAL = "deny-child-scope-traversal";

// ===========================================================================
// hook consumption: demo mode -> the rp1-model input hooks.
// ===========================================================================

/**
 * Map a crossing-UI demo mode onto the buildRp1Section input hooks
 * (`attachmentStatus` / `sessionContextStatus`). This is the ONE place the demo modes and
 * the hooks meet — the gate never re-derives freshness posture on its own.
 * Returns null for an unknown mode (callers must treat that as an invalid request).
 */
export function demoModeToRp1Options(mode) {
  switch (mode) {
    case "off":
      return { attachmentStatus: "active", sessionContextStatus: "active" };
    case "stale-attachment":
      return { attachmentStatus: "stale", sessionContextStatus: "active" };
    case "revoked-session":
      return { attachmentStatus: "active", sessionContextStatus: "revoked" };
    default:
      return null;
  }
}

/**
 * The traversal request each demo mode frames. "revoked-session" frames the crossing as an
 * attempt to REUSE/replay the carried session context through the portal (the J22 no-replay
 * edge); the other modes are the demo's normal LOCAL one-context parent->child traversal.
 */
export function traversalRequestForDemoMode(mode, childScopeRef) {
  return {
    childScopeRef: childScopeRef || null,
    linkMode: "local", // the live crossing is one-context/local
    sessionReplayRequested: mode === "revoked-session",
  };
}

// ===========================================================================
// Surface extraction — works over BOTH the v0.1 RP1 stubs ({name,url}/{name,value} shapes)
// and the v0.4-shaped emission (same RP1 members preserved alongside v0.4 keys),
// and over a bare section ({facets,pointers,consents}).
// ===========================================================================

/** Normalize a manifest or section into the RP1 surface the gate evaluates. */
export function extractRp1Surface(source) {
  const src = source && typeof source === "object" ? source : {};
  const pointers = Array.isArray(src.pointers) ? src.pointers : [];
  const consents = Array.isArray(src.consents) ? src.consents : [];
  const facets = Array.isArray(src.facets) ? src.facets : [];
  const policyFacet = facets.find((f) => f && f.name === FACET_ATTACHMENT_POLICY) || null;
  return {
    pointers,
    consents,
    facets,
    pointerByName: (name) => pointers.find((p) => p && p.name === name) || null,
    consentByName: (name) => consents.find((c) => c && c.name === name) || null,
    attachmentPolicy: policyFacet && policyFacet.entity ? policyFacet.entity : null,
    issuedAt: typeof src.issuedAt === "string" ? src.issuedAt : null,
  };
}

/**
 * Resolve which attachment (parent->child mount) authorizes the requested child scope.
 * Fail-closed: a childScopeRef no attachment names is NOT authorized (returns null — the
 * near-real fixture's "rejectAnyOtherChildScope" posture). With no requested ref, only an
 * unambiguous single-attachment policy resolves.
 */
export function resolveAttachment(policyEntity, childScopeRef) {
  const attachments =
    policyEntity && Array.isArray(policyEntity.attachments) ? policyEntity.attachments : [];
  if (attachments.length === 0) return null;
  if (childScopeRef != null && childScopeRef !== "") {
    return attachments.find((a) => a && a.childScopeRef === childScopeRef) || null;
  }
  return attachments.length === 1 ? attachments[0] : null;
}

// ===========================================================================
// Freshness + session evaluation (the J22 sources).
// ===========================================================================

const KNOWN_STATUS = ["active", "stale", "revoked"];

/**
 * Evaluate a freshness-gated pointer (J22: `observedAt`/`expiresAt`/`status`) at `nowMs`.
 * Fail-closed: a missing pointer, an unknown status token, unparseable/absent expiry
 * metadata, `status: stale|revoked`, or an `expiresAt` at/behind `nowMs` are ALL not fresh.
 */
export function evaluatePointerFreshness(pointer, nowMs) {
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!pointer || typeof pointer !== "object") {
    return { present: false, status: null, expired: null, fresh: false, reason: "pointer-missing" };
  }
  const status = typeof pointer.status === "string" ? pointer.status : null;
  const expiresMs = typeof pointer.expiresAt === "string" ? Date.parse(pointer.expiresAt) : NaN;
  const hasExpiry = Number.isFinite(expiresMs);
  const expired = hasExpiry ? expiresMs <= at : null;
  const out = {
    present: true,
    status,
    observedAt: typeof pointer.observedAt === "string" ? pointer.observedAt : null,
    expiresAt: typeof pointer.expiresAt === "string" ? pointer.expiresAt : null,
    expired,
    fresh: false,
    reason: "",
  };
  if (status !== null && !KNOWN_STATUS.includes(status)) {
    out.reason = `unknown-status:${status} (default-deny)`;
    return out;
  }
  if (status === null) {
    out.reason = "status-missing (uncertain => deny)";
    return out;
  }
  if (status === "stale" || status === "revoked") {
    out.reason = `status:${status}`;
    return out;
  }
  if (!hasExpiry) {
    // No parseable freshness boundary on a freshness-gated pointer = uncertain. The
    // integration doc: "If attachment freshness is stale or uncertain, deny ... rather
    // than guessing."
    out.reason = "freshness-metadata-missing-or-unparseable (uncertain => deny)";
    return out;
  }
  if (expired) {
    out.reason = `expired (expiresAt ${pointer.expiresAt} <= evaluation time)`;
    return out;
  }
  out.fresh = true;
  out.reason = status === "active" ? "active-and-unexpired" : "unexpired (no status token)";
  return out;
}

/**
 * Evaluate the optional, revocable rp1.sessionContext pointer at `nowMs`, plus whether a
 * REPLAY/REUSE of it may proceed. Replay is allowed ONLY when the pointer is present,
 * `status: active`, unexpired, AND `spatial.sessionReplay` is explicitly "allowed".
 * Everything else — revoked, stale, expired, unknown status, missing pointer, missing or
 * denied consent — blocks replay (deny-replay-and-reuse).
 */
export function evaluateSessionContext(pointer, consents, nowMs) {
  const freshness = evaluatePointerFreshness(pointer, nowMs);
  const replayConsent = consentValueOf(consents, CONSENT_SESSION_REPLAY);
  const replayAllowed = freshness.fresh === true && freshness.status === "active" && replayConsent === "allowed";
  return {
    ...freshness,
    replay_consent: replayConsent,
    replay_allowed: replayAllowed,
    replay_block_reason: replayAllowed
      ? null
      : freshness.present === false
        ? "session-context-pointer-missing"
        : freshness.status === "revoked"
          ? "status:revoked — MUST NOT be replayed or reused"
          : freshness.expired === true
            ? "expired — MUST NOT be replayed or reused"
            : replayConsent !== "allowed"
              ? `spatial.sessionReplay:${replayConsent} (consent does not allow replay)`
              : freshness.reason || "not-reusable",
  };
}

/** The value of a {name,value} consent; "absent" when the consent is not present. */
export function consentValueOf(consents, name) {
  const list = Array.isArray(consents) ? consents : [];
  const c = list.find((x) => x && x.name === name);
  return c && typeof c.value === "string" ? c.value : "absent";
}

/**
 * May the requested link proceed under spatial.crossWorldLinking?
 *  - linkMode "local": a denied/absent consent degrades the link to local-only — which is
 *    exactly what a local one-context traversal is, so local passes (the stubs' posture).
 *  - linkMode "cross-world": requires "allowed", or "restricted" WITH a matching audience
 *    token + context (the near-real fixture's audience-scoped exception). Anything else —
 *    denied, absent, restricted-without-match, unknown value — blocks the cross-scope link.
 */
export function evaluateCrossWorldConsent(consents, request) {
  const req = request || {};
  const list = Array.isArray(consents) ? consents : [];
  const consent = list.find((c) => c && c.name === CONSENT_CROSS_WORLD) || null;
  const value = consent && typeof consent.value === "string" ? consent.value : "absent";
  const linkMode = req.linkMode === "cross-world" ? "cross-world" : "local";
  const effectiveVisibility = value === "allowed" ? "cross-world" : value === "restricted" ? "audience-scoped" : "local-only";
  let crossWorldAllowed = false;
  let reason = "";
  if (value === "allowed") {
    crossWorldAllowed = true;
    reason = "spatial.crossWorldLinking:allowed";
  } else if (value === "restricted") {
    const contexts = Array.isArray(consent.contexts) ? consent.contexts : [];
    const audienceMatch =
      consent.audience && typeof consent.audience.match === "string" ? consent.audience.match : null;
    const contextOk = typeof req.context === "string" && contexts.includes(req.context);
    const audienceOk = typeof req.audienceToken === "string" && audienceMatch != null && req.audienceToken === audienceMatch;
    crossWorldAllowed = contextOk && audienceOk;
    reason = crossWorldAllowed
      ? `spatial.crossWorldLinking:restricted — audience+context match (${req.audienceToken} / ${req.context})`
      : "spatial.crossWorldLinking:restricted — no audience/context match (default-deny)";
  } else {
    reason = `spatial.crossWorldLinking:${value} — cross-scope link blocked (linkVisibility: local-only)`;
  }
  return {
    value,
    link_mode: linkMode,
    effective_link_visibility: effectiveVisibility,
    cross_world_allowed: crossWorldAllowed,
    allowed_for_request: linkMode === "local" ? true : crossWorldAllowed,
    reason,
  };
}

// ===========================================================================
// Cycle / repeated-mount safety (integration checklist: "Child-scope traversal handles
// cycles or repeated mounts safely"; near-real fixture: cycleHandling +
// repeatedMountPolicy).
// ===========================================================================

/**
 * A per-traversal visited-scope tracker. `cycleHandling: track-visited-scopes` +
 * `repeatedMountPolicy: single-mount-per-traversal` (the defaults — and, fail-closed, the
 * behavior for ANY unknown policy token): a scope already mounted in this traversal is
 * REFUSED re-entry, so a cyclic A -> B -> A mount chain terminates instead of looping.
 */
export function createTraversalTracker(policyEntity) {
  const cycleHandling =
    policyEntity && typeof policyEntity.cycleHandling === "string"
      ? policyEntity.cycleHandling
      : "track-visited-scopes";
  const repeatedMountPolicy =
    policyEntity && typeof policyEntity.repeatedMountPolicy === "string"
      ? policyEntity.repeatedMountPolicy
      : "single-mount-per-traversal";
  const visited = [];
  return {
    cycle_handling: cycleHandling,
    repeated_mount_policy: repeatedMountPolicy,
    visitedScopes() {
      return visited.slice();
    },
    /** Attempt to mount a scope in this traversal. Repeats are refused (fail-closed). */
    enterScope(scopeRef) {
      const ref = scopeRef == null ? "" : String(scopeRef);
      if (!ref) {
        return { allowed: false, repeated: false, reason: "missing-scope-ref (default-deny)" };
      }
      if (visited.includes(ref)) {
        return {
          allowed: false,
          repeated: true,
          reason: `repeated-mount-refused (${repeatedMountPolicy}; cycle detected via ${cycleHandling})`,
        };
      }
      visited.push(ref);
      return { allowed: true, repeated: false, reason: "first-mount-in-traversal" };
    },
  };
}

// ===========================================================================
// THE GATE — the one decision function the live crossing and the harness call.
// ===========================================================================

/**
 * Decide whether a parent-scope -> child-scope traversal may proceed. FAIL-CLOSED.
 *
 * @param {object} input
 *   manifest | section  The RP1 surface: a v0.1-stub-shaped or v0.4-shaped manifest, or a
 * buildRp1Section result. (`section` wins when both given.)
 *   request             { childScopeRef, linkMode: "local"|"cross-world", context?,
 *                         audienceToken?, sessionReplayRequested?: boolean }
 *   now                 Evaluation time (ms). Defaults to the manifest's issuedAt when
 *                       present (J22 evaluates freshness "at manifest issuance time"),
 *                       else Date.now().
 *   tracker             Optional createTraversalTracker() instance for multi-hop traversals
 *                       (one is created per call when absent).
 * @returns a receipt: { decision: "allow"|"deny", status: "accepted"|"rejected", action,
 *          reasons[], request, checks{...}, fail_closed: true, evaluated_at }.
 */
export function gateChildScopeTraversal(input) {
  const evaluatedAtIso = new Date().toISOString();
  try {
    const src = input && (input.section || input.manifest);
    const surface = extractRp1Surface(src);
    const requestValid = !!(input && input.request && typeof input.request === "object" && !Array.isArray(input.request));
    const request = requestValid ? input.request : {};
    const nowMs = Number.isFinite(input && input.now)
      ? input.now
      : surface.issuedAt && Number.isFinite(Date.parse(surface.issuedAt))
        ? Date.parse(surface.issuedAt)
        : Date.now();

    const reasons = [];
    let action = null;

    if (!requestValid) {
      reasons.push("traversal request missing or malformed (default-deny)");
      action = action || "default-deny";
    }
    if (typeof request.childScopeRef !== "string" || request.childScopeRef.length === 0) {
      reasons.push("request.childScopeRef missing or malformed (default-deny)");
      action = action || DENY_CHILD_SCOPE_TRAVERSAL;
    }
    if (request.linkMode !== "local" && request.linkMode !== "cross-world") {
      reasons.push(`request.linkMode ${JSON.stringify(request.linkMode)} is not local|cross-world (default-deny)`);
      action = action || "default-deny";
    }
    if (request.sessionReplayRequested !== undefined && typeof request.sessionReplayRequested !== "boolean") {
      reasons.push("request.sessionReplayRequested must be boolean when present (default-deny)");
      action = action || "default-deny";
    }

    // --- 1) Attachment policy + attachment resolution (unknown mount => deny) ----------
    const policy = surface.attachmentPolicy;
    const attachment = resolveAttachment(policy, request.childScopeRef || null);
    const policyFacetCount = surface.facets.filter((facet) => facet && facet.name === FACET_ATTACHMENT_POLICY).length;
    const matchingAttachmentCount =
      policy && Array.isArray(policy.attachments) && typeof request.childScopeRef === "string"
        ? policy.attachments.filter((candidate) => candidate && candidate.childScopeRef === request.childScopeRef).length
        : 0;
    const policyCheck = {
      present: !!policy,
      attachment_resolved: !!attachment,
      attachment_point_id: attachment ? attachment.attachmentPointId || null : null,
      child_scope_ref: attachment ? attachment.childScopeRef || null : request.childScopeRef || null,
      freshness_source: attachment ? attachment.freshnessSource || null : null,
      on_freshness_failure: attachment ? attachment.onFreshnessFailure || null : null,
      link_visibility: attachment ? attachment.linkVisibility || null : null,
      consent_required: attachment && Array.isArray(attachment.consentRequired) ? attachment.consentRequired.slice() : [],
    };
    if (!policy) {
      reasons.push("no spatialFabricAttachmentPolicy facet — cannot authorize a child-scope mount (default-deny)");
      action = action || "default-deny";
    } else if (policyFacetCount !== 1) {
      reasons.push(`expected exactly one spatialFabricAttachmentPolicy facet, found ${policyFacetCount} (ambiguous => default-deny)`);
      action = action || "default-deny";
    } else if (!attachment) {
      reasons.push(
        `no attachment authorizes child scope ${JSON.stringify(request.childScopeRef || null)} (reject-any-other-child-scope; default-deny)`
      );
      action = action || DENY_CHILD_SCOPE_TRAVERSAL;
    } else if (matchingAttachmentCount !== 1) {
      reasons.push(`expected exactly one attachment for ${JSON.stringify(request.childScopeRef)}, found ${matchingAttachmentCount} (ambiguous => default-deny)`);
      action = action || DENY_CHILD_SCOPE_TRAVERSAL;
    }

    // --- 2) Attachment freshness (J22: stale/expired/uncertain => deny traversal) -------
    const freshnessSource = policyCheck.freshness_source || PTR_ATTACHMENT_INDEX;
    const attachmentPointers = surface.pointers.filter((pointer) => pointer && pointer.name === PTR_ATTACHMENT_INDEX);
    const attachmentFreshness = evaluatePointerFreshness(attachmentPointers[0] || null, nowMs);
    attachmentFreshness.freshness_source = freshnessSource;
    if (attachment && freshnessSource !== PTR_ATTACHMENT_INDEX) {
      reasons.push(`attachment freshnessSource must be ${PTR_ATTACHMENT_INDEX}, got ${JSON.stringify(freshnessSource)} (default-deny)`);
      action = action || DENY_CHILD_SCOPE_TRAVERSAL;
    }
    if (attachment && attachmentPointers.length !== 1) {
      reasons.push(`expected exactly one ${PTR_ATTACHMENT_INDEX} pointer, found ${attachmentPointers.length} (ambiguous => default-deny)`);
      action = action || DENY_CHILD_SCOPE_TRAVERSAL;
    }
    if (attachment && !attachmentFreshness.fresh) {
      // Honor the policy's declared failure action; ANY unknown/missing token stays the
      // fail-closed deny (never an open fallback).
      const declared = policyCheck.on_freshness_failure;
      const failureAction = declared === DENY_CHILD_SCOPE_TRAVERSAL ? declared : DENY_CHILD_SCOPE_TRAVERSAL;
      reasons.push(
        `attachment freshness failed on ${freshnessSource} (${attachmentFreshness.reason}) => ${failureAction}` +
          (declared === DENY_CHILD_SCOPE_TRAVERSAL ? "" : ` (declared onFreshnessFailure=${JSON.stringify(declared)}; unknown => default-deny)`)
      );
      action = action || failureAction;
    }

    // --- 3) Consent gate (cross-scope link blocked when consent denied) -----------------
    const consentGate = evaluateCrossWorldConsent(surface.consents, request);
    consentGate.required = policyCheck.consent_required;
    const consentRequired = policyCheck.consent_required.includes(CONSENT_CROSS_WORLD);
    consentGate.gates_this_attachment = consentRequired;
    const crossWorldConsentCount = surface.consents.filter((consent) => consent && consent.name === CONSENT_CROSS_WORLD).length;
    if (attachment && crossWorldConsentCount > 1) {
      reasons.push(`expected at most one ${CONSENT_CROSS_WORLD} consent, found ${crossWorldConsentCount} (ambiguous => default-deny)`);
      action = action || "deny-cross-scope-link";
    }
    if (attachment && request.linkMode === "cross-world" && !consentGate.cross_world_allowed) {
      reasons.push(consentGate.reason);
      action = action || "deny-cross-scope-link";
    }
    // Any OTHER required consent must be explicitly allowed (unknown requirement => deny).
    for (const key of policyCheck.consent_required) {
      if (key === CONSENT_CROSS_WORLD) continue;
      const v = consentValueOf(surface.consents, key);
      if (v !== "allowed") {
        reasons.push(`required consent ${key} is ${v} (default-deny)`);
        action = action || "default-deny";
      }
    }

    // --- 4) Session context (J22: revoked/expired => no replay, no reuse) ---------------
    const sessionPointers = surface.pointers.filter((pointer) => pointer && pointer.name === PTR_SESSION_CONTEXT);
    const sessionContext = evaluateSessionContext(sessionPointers[0] || null, surface.consents, nowMs);
    sessionContext.replay_requested = request.sessionReplayRequested === true;
    if (sessionContext.replay_requested && sessionPointers.length !== 1) {
      reasons.push(`expected exactly one ${PTR_SESSION_CONTEXT} pointer for replay, found ${sessionPointers.length} (ambiguous => default-deny)`);
      action = action || "deny-replay-and-reuse";
    }
    if (sessionContext.replay_requested && !sessionContext.replay_allowed) {
      reasons.push(`session-context replay refused: ${sessionContext.replay_block_reason}`);
      action = action || "deny-replay-and-reuse";
    }

    // --- 5) Cycle / repeated-mount safety (only an otherwise-allowed mount consumes a
    //         tracker slot; a repeated mount within one traversal is refused) ------------
    const tracker = input && input.tracker ? input.tracker : createTraversalTracker(policy);
    const cycleCheck = {
      cycle_handling: tracker.cycle_handling,
      repeated_mount_policy: tracker.repeated_mount_policy,
      scope_ref: policyCheck.child_scope_ref,
      attempted: false,
      repeated: false,
      refused: false,
      visited_count: tracker.visitedScopes().length,
    };
    if (reasons.length === 0) {
      const enter = tracker.enterScope(policyCheck.child_scope_ref);
      cycleCheck.attempted = true;
      cycleCheck.repeated = enter.repeated === true;
      cycleCheck.refused = enter.allowed !== true;
      cycleCheck.visited_count = tracker.visitedScopes().length;
      if (!enter.allowed) {
        reasons.push(`cycle/repeated-mount safety refused the mount: ${enter.reason}`);
        action = action || "refuse-repeated-mount";
      }
    }

    const deny = reasons.length > 0;
    return {
      "@type": "rp1:TraversalGateReceipt",
      gate: "web/rp1-fail-closed.mjs",
      evaluated_at: evaluatedAtIso,
      evaluated_at_ms: nowMs,
      decision: deny ? "deny" : "allow",
      status: deny ? "rejected" : "accepted",
      action: deny ? action || "default-deny" : "proceed",
      reasons: deny ? reasons : ["all fail-closed checks passed (fresh attachment; consent satisfied for the requested link mode; no replay of revoked/expired session; first mount in traversal)"],
      request: {
        childScopeRef: request.childScopeRef || null,
        linkMode: request.linkMode === "cross-world" ? "cross-world" : "local",
        context: request.context || null,
        audienceToken: request.audienceToken || null,
        sessionReplayRequested: request.sessionReplayRequested === true,
      },
      checks: {
        attachment_policy: policyCheck,
        attachment_freshness: attachmentFreshness,
        consent_gate: consentGate,
        session_context: sessionContext,
        cycle_safety: cycleCheck,
      },
      fail_closed: true,
    };
  } catch (e) {
    // FAIL-CLOSED on internal error: an evaluation the gate cannot complete is an unknown
    // condition — DENY, with the error surfaced honestly (never swallowed, never open).
    return {
      "@type": "rp1:TraversalGateReceipt",
      gate: "web/rp1-fail-closed.mjs",
      evaluated_at: evaluatedAtIso,
      decision: "deny",
      status: "rejected",
      action: "default-deny",
      reasons: [`internal-error:${(e && e.message) || "unknown"} (unknown condition => default-deny)`],
      request: null,
      checks: null,
      fail_closed: true,
    };
  }
}
// END (new file — fence markers kept for a uniform search)
