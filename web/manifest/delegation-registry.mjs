// v0.4 agent-delegation pointers + O7 scope registry.
//
// Owns HOLD-13 (`um:agentDelegation`, Base §6.5/§6.5.1) and the EXT-OPT O7
// scope-registry lookup. Browser-safe (no Node built-ins); the standalone
// Node driver that PROVES it against the external suite is verify.mjs.
//
// External source of truth (READ-ONLY):
//   - spec/v0.4/schema.json          $defs.agentDelegationPointer (the shape)
//   - spec/v0.4/CONFORMANCE.md §6.8   holder MUST §3.13 / adversarial §6.8
//   - docs/spec-v0.4/ext-opt.html O7  the registered scope value set
//
// WHAT THIS MODULE OWNS (the four fixtures in conformance/v0.4/expected.json):
//   valid/manifest-with-agent-delegation-scopes        structural accept  (registered O7 scopes)
//   valid/agent-delegation-fail-closed-defaults        accepted-with-warnings
//                                                       (empty-scope + unattributed)
//   invalid/agent-delegation-delegatedby-mismatch      reject (delegator binding, §6.5.1)
//   invalid/agent-delegation-expired                   rejected + delegation:expired warning
//
// HONESTY CEILING (never overclaimed):
//   - An UNREGISTERED, EMPTY, or AMBIGUOUS delegated scope DENIES by default:
//     it grants NO capability. Only scopes present in the O7 core registry
//     become effective. Fail-closed is the default, not the exception.
//   - `delegatedBy` MUST equal the manifest `subject` (delegator binding) or the
//     whole delegation is rejected — an agent cannot be handed authority the
//     signer never held.
//   - `livenessEndpoint` is carried verbatim if present but this change claims NO
//     liveness semantics for it (that vocabulary is). Grade-2 carry-only.
//   - No `um_conformance` flag is flipped by this module (see feature_CONFORMANCE).

import { verifyManifestProfileA } from "../signing/um-signature-profile-a.mjs";

// ===========================================================================
// 0) Constants — the schema enum + the O7 registered scope set + warning codes
// ===========================================================================

export const AGENT_DELEGATION_TYPE = "um:agentDelegation";

/** schema.json $defs.agentDelegationPointer.delegateType enum (closed set). */
export const DELEGATE_TYPES = Object.freeze(["ai-agent", "bot", "proxy", "human-delegate"]);

/**
 * EXT-OPT §O7 core registered scope values. "All evaluators recognizing
 * um:agentDelegation pointers MUST understand these." Values are the ONLY
 * tokens that become effective capabilities; everything else is restricted
 * out (fail closed). Names follow the O7 <domain>.<capability> convention.
 * (Source: docs/spec-v0.4/ext-opt.html §O7 "Core scope values"; do NOT invent
 * scope tokens — new values register through the O6 profile mechanism.)
 */
export const O7_CORE_SCOPES = Object.freeze({
  "spatial.session": "participate in spatial computing sessions on behalf of the subject",
  "spatial.navigation": "navigate spatial environments",
  "social.messaging": "send and receive messages",
  "social.presence": "represent the subject's presence status",
  "commerce.transaction": "initiate transactions, within any profile-declared spending limits",
  "identity.attestation": "present the subject's identity claims to verifiers (NOT authority to create or modify claims)",
});

/** Receipt-observable warning markers (substring-assertable; no closed wire enum). */
export const WARN_DELEGATION_EXPIRED = "um:reason:delegation:expired";
export const WARN_DELEGATION_EMPTY_SCOPE = "um:reason:delegation:empty-scope";
export const WARN_DELEGATION_UNATTRIBUTED = "um:reason:delegation:unattributed";
// O7 "evaluator behavior for unrecognized scopes": record + restrict. Not asserted
// by a fixture, implemented for the honesty ceiling and exercised live in the driver.
export const WARN_DELEGATION_UNREGISTERED_SCOPE = "um:reason:delegation:unregistered-scope";
// Delegator-binding failure. The verdict is a hard REJECT; the marker is for the
// receipt/demo surface (the mismatch fixture asserts the reject, not this string).
export const WARN_DELEGATION_DELEGATOR_MISMATCH = "um:reason:delegation:delegator-mismatch";

/** Honest capability descriptor — mirrors feature_CONFORMANCE. Flips nothing. */
export const feature_CONFORMANCE = Object.freeze({
  wo: "runtime",
  standard: "Universal Manifest v0.4 Base §6.5/§6.5.1 (agent delegation) + EXT-OPT §O7 (scope registry)",
  fixtures_owned: 4,
  // REAL, deterministic surfaces:
  delegator_binding_real: true, // delegatedBy === subject, else reject (§6.5.1)
  expiry_enforcement_real: true, // now > expiresAt at the pinned clock ⇒ reject
  o7_registry_lookup_real: true, // registered-scope membership; unregistered restricted out
  fail_closed_defaults_real: true, // empty scope grants nothing; missing delegateId ⇒ unattributed
  structural_shape_validation_real: true, // schema $defs.agentDelegationPointer mirrored
  // Deliberately NOT claimed:
  liveness_endpoint_semantics: false, // carry-only; owns liveness (Grade-2)
  full_six_stage_evaluator: false, // this is the delegation slice; composes
  um_conformance_flag_flipped: false,
  scoped_claim:
    "runtime implements REAL, deterministic agent-delegation evaluation: delegator binding " +
    "(delegatedBy === subject or reject), expiry at the pinned clock, O7 registered-scope lookup " +
    "with fail-closed defaults (empty/unregistered scope grants NO capability; missing delegateId " +
    "is unattributed), and structural shape validation mirroring schema.json. An unregistered or " +
    "ambiguous delegated scope DENIES by default. livenessEndpoint is carry-only (no liveness " +
    "semantics claimed — runtime). No conformance flag is flipped.",
});

// ===========================================================================
// 1) Small helpers (browser-safe; mirror the helper style)
// ===========================================================================

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isIsoDateTime(v) {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

/** True iff `scope` is a value in the O7 core registry (exact membership). */
export function isRegisteredScope(scope) {
  return typeof scope === "string" && Object.prototype.hasOwnProperty.call(O7_CORE_SCOPES, scope);
}

/** Registry description for a scope, or null if unregistered. */
export function lookupScope(scope) {
  return isRegisteredScope(scope) ? O7_CORE_SCOPES[scope] : null;
}

/**
 * Split a requested scope array into { registered, unregistered } (order-preserving,
 * de-duplicated). Non-string entries are treated as unregistered garbage.
 */
export function partitionScopes(scopes) {
  const registered = [];
  const unregistered = [];
  const seen = new Set();
  for (const s of Array.isArray(scopes) ? scopes : []) {
    const key = String(s);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isRegisteredScope(s)) registered.push(s);
    else unregistered.push(s);
  }
  return { registered, unregistered };
}

/** All `um:agentDelegation` pointers carried in manifest.pointers[]. */
export function getAgentDelegationPointers(manifest) {
  const pointers = manifest && Array.isArray(manifest.pointers) ? manifest.pointers : [];
  return pointers.filter((p) => p && typeof p === "object" && p["@type"] === AGENT_DELEGATION_TYPE);
}

// ===========================================================================
// 2) Structural shape validation — mirrors schema.json $defs.agentDelegationPointer
//    (the "schema-detectable" layer; clock-independent, subject-independent)
// ===========================================================================

/**
 * Validate ONE agentDelegation pointer's shape against the schema conditional.
 * Required: @type, delegateType (enum), delegatedBy (non-empty string),
 * delegatedAt (date-time), expiresAt (date-time). Optional: delegateId (string),
 * scope (string[]), livenessEndpoint (uri). Returns { valid, errors }.
 */
export function validateAgentDelegationShape(pointer) {
  const errors = [];
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) {
    return { valid: false, errors: ["agentDelegation pointer must be an object"] };
  }
  if (pointer["@type"] !== AGENT_DELEGATION_TYPE) {
    errors.push(`@type must be "${AGENT_DELEGATION_TYPE}"`);
  }
  if (!DELEGATE_TYPES.includes(pointer.delegateType)) {
    errors.push(`delegateType must be one of ${DELEGATE_TYPES.join("|")}`);
  }
  if (!isNonEmptyString(pointer.delegatedBy)) errors.push("delegatedBy is required (non-empty string)");
  if (!isIsoDateTime(pointer.delegatedAt)) errors.push("delegatedAt must be an ISO 8601 date-time");
  if (!isIsoDateTime(pointer.expiresAt)) errors.push("expiresAt must be an ISO 8601 date-time");
  if (pointer.delegateId !== undefined && typeof pointer.delegateId !== "string") {
    errors.push("delegateId must be a string when present");
  }
  if (pointer.scope !== undefined && (!Array.isArray(pointer.scope) || pointer.scope.some((s) => typeof s !== "string"))) {
    errors.push("scope must be an array of strings when present");
  }
  if (pointer.livenessEndpoint !== undefined && !isNonEmptyString(pointer.livenessEndpoint)) {
    errors.push("livenessEndpoint must be a URI string when present");
  }
  return { valid: errors.length === 0, errors };
}

// ===========================================================================
// 3) The delegation evaluator — delegator binding + expiry + fail-closed O7 defaults
// ===========================================================================

/**
 * Evaluate ONE agentDelegation pointer against the manifest subject at a pinned
 * clock. Returns a receipt-observable record:
 *   { reject, rejectReason, warnings:[{code,message}], delegation:{...} }
 * Fail-closed everywhere: an unregistered/empty/ambiguous scope grants NOTHING.
 */
export function evaluateDelegation(pointer, { subject, nowMs } = {}) {
  const warnings = [];
  const shape = validateAgentDelegationShape(pointer);
  if (!shape.valid) {
    // Schema-detectable defect — not exercised by the four owned fixtures, but
    // fail closed for robustness. Reject with the structural reason.
    return {
      reject: true,
      rejectReason: `agentDelegation shape invalid: ${shape.errors.join("; ")}`,
      warnings,
      delegation: { status: "rejected", shapeErrors: shape.errors },
    };
  }

  const requested = Array.isArray(pointer.scope) ? pointer.scope : [];
  const { registered, unregistered } = partitionScopes(requested);
  const attributed = isNonEmptyString(pointer.delegateId);

  const delegation = {
    delegateType: pointer.delegateType,
    delegateId: attributed ? pointer.delegateId : null,
    delegatedBy: pointer.delegatedBy,
    delegatorMatchesSubject: pointer.delegatedBy === subject,
    delegatedAt: pointer.delegatedAt,
    expiresAt: pointer.expiresAt,
    expired: false,
    attributed,
    requestedScopes: requested.slice(),
    registeredScopes: registered.slice(),
    unregisteredScopes: unregistered.slice(),
    effectiveScopes: registered.slice(), // ONLY registered scopes are ever effective
    status: "accepted",
  };

  // (a) Delegator binding (Base §6.5.1) — HARD REJECT if delegatedBy !== subject.
  //     Clock-independent; this is what the delegatedby-mismatch fixture asserts.
  if (pointer.delegatedBy !== subject) {
    warnings.push({
      code: WARN_DELEGATION_DELEGATOR_MISMATCH,
      message: `Verify stage: delegatedBy "${pointer.delegatedBy}" does not match manifest subject "${subject}" (Base §6.5.1)`,
    });
    delegation.status = "rejected";
    return {
      reject: true,
      rejectReason: `delegatedBy "${pointer.delegatedBy}" does not match manifest subject "${subject}"`,
      warnings,
      delegation,
    };
  }

  // (b) Expiry (Base §6.5.1) — HARD REJECT if now > expiresAt. Clock-DEPENDENT.
  if (Number.isFinite(nowMs) && nowMs > Date.parse(pointer.expiresAt)) {
    delegation.expired = true;
    delegation.effectiveScopes = []; // an expired delegation grants nothing
    delegation.status = "rejected";
    warnings.push({
      code: WARN_DELEGATION_EXPIRED,
      message: `Verify stage: delegation expired (expiresAt ${pointer.expiresAt} is before evaluation clock)`,
    });
    return {
      reject: true,
      rejectReason: `delegation expired at ${pointer.expiresAt}`,
      warnings,
      delegation,
    };
  }

  // (c) Fail-closed defaults (Base §6.5.1 + O7). These are NOT rejects — they are
  //     receipt-observable warnings; the delegation is accepted-with-warnings.

  // O7 unrecognized-scope behavior: record them + restrict the delegate to only
  // the recognized scopes (delegate MUST NOT exercise unregistered capabilities).
  if (unregistered.length > 0) {
    warnings.push({
      code: WARN_DELEGATION_UNREGISTERED_SCOPE,
      message: `Compose stage: ${unregistered.length} unregistered scope(s) restricted out (O7): ${unregistered.join(", ")}`,
    });
  }

  // Empty effective scope ⇒ grants NO capabilities. Fires for a literally empty
  // scope OR a scope that contained only unregistered tokens (O7: "SHOULD treat
  // the delegation as having no effective scope").
  if (delegation.effectiveScopes.length === 0) {
    warnings.push({
      code: WARN_DELEGATION_EMPTY_SCOPE,
      message: "Compose stage: empty effective scope — delegation grants no capabilities (fail-closed default, Base §6.5.1)",
    });
  }

  // Missing delegateId ⇒ attributed to no agent.
  if (!attributed) {
    warnings.push({
      code: WARN_DELEGATION_UNATTRIBUTED,
      message: "Compose stage: no delegateId — delegation is attributed to no agent (fail-closed default, Base §6.5.1)",
    });
  }

  delegation.status = warnings.length > 0 ? "accepted-with-warnings" : "accepted";
  return { reject: false, rejectReason: null, warnings, delegation };
}

// ===========================================================================
// 4) Envelope basics + structural + evaluation verdicts (mirror shape)
// ===========================================================================

function envelopeErrors(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["manifest must be an object"];
  const ctx = manifest["@context"];
  const hasV04 =
    ctx === "https://universalmanifest.net/ns/v0.4" ||
    (Array.isArray(ctx) && ctx.includes("https://universalmanifest.net/ns/v0.4"));
  if (!hasV04) errors.push("@context must include https://universalmanifest.net/ns/v0.4 (Section 1.2.1)");
  if (!isNonEmptyString(manifest["@id"])) errors.push("Missing @id");
  const t = manifest["@type"];
  const hasType = t === "um:Manifest" || (Array.isArray(t) && t.includes("um:Manifest"));
  if (!hasType) errors.push("Missing um:Manifest in @type");
  if (manifest.manifestVersion !== "0.4") errors.push("manifestVersion must be 0.4");
  if (!isNonEmptyString(manifest.subject)) errors.push("Missing subject");
  if (!isIsoDateTime(manifest.issuedAt)) errors.push("issuedAt must be an ISO 8601 date-time");
  if (!isIsoDateTime(manifest.expiresAt)) errors.push("expiresAt must be an ISO 8601 date-time");
  return errors;
}

/**
 * STRUCTURAL verdict (clock-independent; no receipt): envelope basics → every
 * agentDelegation pointer's shape → DELEGATOR BINDING (delegatedBy === subject,
 * a clock-independent semantic check folded here exactly as folds its VP
 * size limit) → Profile A signature. Returns { result, reasons, checks }.
 * NOTE: expiry is deliberately NOT checked here (it is clock-DEPENDENT and lives
 * in evaluateDelegationRegistry) — this verdict backs fixtures with no pinned evaluationContext.
 */
export async function structuralVerdictDelegationRegistry(manifest) {
  const reasons = [];
  reasons.push(...envelopeErrors(manifest));

  if (reasons.length === 0) {
    const subject = manifest.subject;
    for (const pointer of getAgentDelegationPointers(manifest)) {
      const shape = validateAgentDelegationShape(pointer);
      if (!shape.valid) {
        reasons.push(...shape.errors);
        continue;
      }
      // Delegator binding is clock-independent ⇒ belongs in the structural verdict.
      if (pointer.delegatedBy !== manifest.subject) {
        reasons.push(
          `agentDelegation.delegatedBy "${pointer.delegatedBy}" does not match manifest subject "${subject}" (Base §6.5.1)`
        );
      }
    }
  }

  let sigReport = null;
  if (reasons.length === 0) {
    // Signature LAST: a shape/binding defect reports its own reason, not a crypto one.
    sigReport = await verifyManifestProfileA(manifest);
    if (!sigReport.ok) reasons.push(`signature verification failed: ${sigReport.reason}`);
  }
  return {
    result: reasons.length === 0 ? "accept" : "reject",
    reasons,
    checks: { signature: sigReport ? sigReport.reason : "not-evaluated" },
  };
}

/**
 * EVALUATION verdict at the PINNED evaluationContext (never the wall clock):
 *   Verify structure + shape + signature → per-pointer delegator binding →
 *   expiry at context.now → fail-closed O7 defaults → outcome.
 * Returns { result, receipt } where receipt carries { outcome, warnings[],
 * delegations[] } — outcome ∈ accepted | accepted-with-warnings | rejected.
 */
export async function evaluateDelegationRegistry(manifest, context = {}) {
  const nowMs = isIsoDateTime(context.now) ? Date.parse(context.now) : Date.now();
  const manifestId = manifest && typeof manifest === "object" && isNonEmptyString(manifest["@id"]) ? manifest["@id"] : "(unknown)";
  const warnings = [];
  const delegations = [];
  const receipt = {
    "@type": "um:Receipt",
    manifestId,
    outcome: "rejected",
    signatureCheck: "not-evaluated",
    delegations,
    warnings,
  };
  const finish = (outcome) => {
    receipt.outcome = outcome;
    return { result: outcome === "rejected" ? "reject" : "accept", receipt };
  };

  // --- Verify: structure ----------------------------------------------------
  const envErrors = envelopeErrors(manifest);
  if (envErrors.length > 0) {
    warnings.push({ code: "um:reason:structure:malformed", message: `Verify stage: ${envErrors.join("; ")}` });
    return finish("rejected");
  }
  const pointers = getAgentDelegationPointers(manifest);
  for (const pointer of pointers) {
    const shape = validateAgentDelegationShape(pointer);
    if (!shape.valid) {
      warnings.push({ code: "um:reason:structure:malformed", message: `Verify stage: ${shape.errors.join("; ")}` });
      return finish("rejected");
    }
  }

  // --- Verify: signature --------------------------
  const sig = manifest.signature;
  if (!sig || typeof sig !== "object") {
    receipt.signatureCheck = "missing";
    warnings.push({ code: "um:reason:crypto:signature-missing", message: "Verify stage: missing signature" });
    return finish("rejected");
  }
  const sigReport = await verifyManifestProfileA(manifest);
  if (!sigReport.ok) {
    receipt.signatureCheck = sigReport.reason === "unsupported-profile" ? "unsupported-profile" : "invalid";
    warnings.push({
      code: sigReport.reason === "unsupported-profile" ? "um:reason:crypto:unsupported-profile" : "um:reason:crypto:signature-invalid",
      message: `Verify stage: ${sigReport.reason}`,
    });
    return finish("rejected");
  }
  receipt.signatureCheck = "valid";

  // --- Compose: per-pointer delegation evaluation (binding → expiry → defaults)
  let anyReject = false;
  for (const pointer of pointers) {
    const out = evaluateDelegation(pointer, { subject: manifest.subject, nowMs });
    delegations.push(out.delegation);
    warnings.push(...out.warnings);
    if (out.reject) anyReject = true;
  }

  // --- Outcome --------------------------------------------------------------
  if (anyReject) return finish("rejected");
  if (warnings.length > 0) return finish("accepted-with-warnings");
  return finish("accepted");
}

// ===========================================================================
// 5) EMIT — a demo agentDelegation pointer (task deliverable #1)
// ===========================================================================

/**
 * Build a well-formed `um:agentDelegation` pointer delegating from `delegatedBy`
 * (MUST be the manifest subject) to an ai_agent/bot delegate, carrying ONLY
 * registered O7 scopes and a bounded expiresAt. Throws if any scope is not in
 * the O7 registry (the holder can never emit a token the evaluator would strip).
 * `livenessEndpoint` is carried verbatim if provided (no liveness semantics).
 */
export function emitAgentDelegationPointer({
  delegatedBy,
  delegateId,
  delegateType = "ai-agent",
  scope = [],
  delegatedAt,
  expiresAt,
  livenessEndpoint,
} = {}) {
  if (!isNonEmptyString(delegatedBy)) throw new Error("emitAgentDelegationPointer: delegatedBy (manifest subject) is required");
  if (!DELEGATE_TYPES.includes(delegateType)) throw new Error(`emitAgentDelegationPointer: delegateType must be one of ${DELEGATE_TYPES.join("|")}`);
  const bad = (Array.isArray(scope) ? scope : []).filter((s) => !isRegisteredScope(s));
  if (bad.length > 0) throw new Error(`emitAgentDelegationPointer: unregistered O7 scope(s): ${bad.join(", ")}`);
  const now = isIsoDateTime(delegatedAt) ? delegatedAt : new Date().toISOString();
  const pointer = {
    "@type": AGENT_DELEGATION_TYPE,
    delegateType,
    delegatedBy,
    delegatedAt: now,
    expiresAt: isIsoDateTime(expiresAt) ? expiresAt : new Date(Date.parse(now) + 3600_000).toISOString(),
    scope: (Array.isArray(scope) ? scope : []).slice(),
  };
  if (isNonEmptyString(delegateId)) pointer.delegateId = delegateId;
  if (isNonEmptyString(livenessEndpoint)) pointer.livenessEndpoint = livenessEndpoint; // carry-only
  return pointer;
}

// ===========================================================================
// 6) DEMO SURFACE — the ai_agent inspect panel (delegator DID, scopes, expiry)
//    + the expired-delegation toggle showing the reject path. Pure functions;
//    the UI wiring into live-adapter.js is the a serialized edit.
// ===========================================================================

/**
 * Produce the inspect-panel view-model for the scene's ai_agent avatar plus a
 * paired "expired toggle" that flips the same delegation into the reject path.
 * Returns { live, expired } — each an evaluated receipt view a panel can render.
 */
export async function buildDelegationDemoSurface({ manifest, now, ai_agentLabel = "ai_agent" } = {}) {
  const nowIso = isIsoDateTime(now) ? now : new Date().toISOString();
  const live = await evaluateDelegationRegistry(manifest, { now: nowIso });

  // Expired toggle: re-evaluate the SAME manifest at a clock AFTER every
  // delegation's expiresAt — the honest reject path the demo shows on demand.
  const pointers = getAgentDelegationPointers(manifest);
  const latestExpiry = pointers.reduce((m, p) => Math.max(m, Date.parse(p.expiresAt) || 0), 0);
  const afterExpiry = new Date(latestExpiry + 1000).toISOString();
  const expired = await evaluateDelegationRegistry(manifest, { now: afterExpiry });

  return {
    label: ai_agentLabel,
    live: {
      outcome: live.receipt.outcome,
      delegations: live.receipt.delegations,
      warnings: live.receipt.warnings,
      evaluatedAt: nowIso,
    },
    expired: {
      outcome: expired.receipt.outcome,
      delegations: expired.receipt.delegations,
      warnings: expired.receipt.warnings,
      evaluatedAt: afterExpiry,
    },
  };
}

// ===========================================================================
// 7) CONFORMANCE-RUNNER REGISTRATION HOOK — mirrors registerHolderBinding. The shared
//    v0.4 runner wires this with ONE line (applied at integration, NOT here).
// ===========================================================================

/** The 4 fixture files owns (task §1 / expected.json). */
export const feature_FIXTURE_FILENAMES = Object.freeze([
  "valid/manifest-with-agent-delegation-scopes.jsonld",
  "valid/agent-delegation-fail-closed-defaults.jsonld",
  "invalid/agent-delegation-delegatedby-mismatch.jsonld",
  "invalid/agent-delegation-expired.jsonld",
]);

/**
 * Evaluate ONE fixture against its expected.json entry contract:
 *   entry.validationMode "evaluation" ⇒ evaluateDelegationRegistry under entry.evaluationContext
 *   otherwise                         ⇒ structuralVerdictDelegationRegistry (clock-independent)
 * Returns { result: "accept"|"reject", reason, receipt? } — the same adapter
 * shape featureFixtureHandler returns, so the shared runner dispatches with no
 * impedance mismatch.
 */
export async function featureFixtureHandler(fixtureJson, expectedEntry = {}) {
  if (expectedEntry.validationMode === "evaluation") {
    const { result, receipt } = await evaluateDelegationRegistry(fixtureJson, expectedEntry.evaluationContext || {});
    return {
      result,
      reason: receipt.warnings?.[0]?.message || receipt.outcome,
      receipt,
    };
  }
  const verdict = await structuralVerdictDelegationRegistry(fixtureJson);
  return { result: verdict.result, reason: verdict.reasons.join("; ") || "structural contract satisfied" };
}

/**
 * Registration hook for the shared v0.4 conformance runner. Contract:
 *   registry.register(filename, asyncHandler(fixtureJson, expectedEntry))
 * The integrator wires it with exactly (mirrors the block):
 *   import { registerDelegationRegistry } from "../manifest/delegation-registry.mjs";
 *   registerDelegationRegistry(registry);
 */
export function registerDelegationRegistry(registry) {
  if (!registry || typeof registry.register !== "function") {
    throw new Error("registerDelegationRegistry: registry with a register(filename, handler) function required");
  }
  for (const filename of feature_FIXTURE_FILENAMES) {
    registry.register(filename, featureFixtureHandler);
  }
  return feature_FIXTURE_FILENAMES.length;
}
