// Universal Manifest v0.4 interface contracts (PUBLISHED EARLY).
//
// This module is the single, published source of truth for the two interface
// SHAPES that the parallel tracks bind against:
//   - consumes AvatarDefinition — the
//     v0.4 *avatar-facet* shape the emitter turns into a manifest facet.
//   - consumes LoadingPointer — the v0.4
//     *pointer* shape the emitter turns into a manifest pointer.
// Publishing these first (before those tracks finish) is a deliberate
// requirement: it closes the interface seam so 126/127 build against a fixed
// contract instead of guessing.
//
// It has ZERO browser dependencies (pure data + pure validators over plain
// objects), so it imports cleanly into Node from a `.mjs` file regardless of the
// prototype's package.json `type:commonjs` (which only governs `.js` resolution) —
// the same portability trick web/geopose-basic-sdu.mjs and web/iwps-query-teleport.mjs
// use.
//
// ---------------------------------------------------------------------------
// WHY THESE SHAPES ARE v0.4-FACET / v0.4-POINTER SHAPED (not ad-hoc)
// ---------------------------------------------------------------------------
// The demo's emitted manifest targets Universal Manifest v0.4 (spec/v0.4/schema.json).
// In v0.4:
//   - A facet REQUIRES `@id` AND `@type` (schema.json $defs/facet, line 103) — v0.1
//     required only `@type`. So AvatarDefinition MUST carry a facet `@id` + a `@type`
//     that includes `um:Facet`.
//   - A pointer REQUIRES `@type` (schema.json $defs/pointer, line 431). Optional
//     members are `target`, `@id`, `label`, `createdAt`, `expiresAt`. So LoadingPointer
//     MUST carry a `@type` string and MAY carry a `target` (the loading content URL,
//     e.g. the IWPS downloadUrl landed) + `expiresAt`.
// Keeping the interfaces literally v0.4-shaped means the emitter (um-manifest-emitter.mjs)
// drops them into `facets[]` / `pointers[]` with only identity/URN normalization — no
// second shape to drift out of schema-validity.
//
// ---------------------------------------------------------------------------
// SCOPE / HONESTY (read before touching the labels)
// ---------------------------------------------------------------------------
// These are STRUCTURAL interface contracts. Conforming to them makes the emitted
// facet/pointer *schema-shaped* for v0.4 — it is NOT a UM conformance claim (that is
// evaluator conformance + live signing, handled by /117b/119, and gated behind
// the `um_conformance` flag which this change does NOT flip). The validators below check
// SHAPE only; they do not verify signatures, consent semantics, or tier logic.

// ===========================================================================
// The v0.4 canonical constants these interfaces are pinned to.
// ===========================================================================
export const UM_V04_CONTEXT = "https://universalmanifest.net/ns/v0.4";
export const UM_V04_MANIFEST_VERSION = "0.4";
export const UM_FACET_TYPE = "um:Facet";
export const UM_ENTITY_TYPE = "um:Entity";
// The v0.4 pointer @type the demo uses for a loading-content pointer. A plain
// (non-delegation) pointer's @type is a free string (schema.json $defs/pointer only
// requires it be a non-empty string). We use a stable, namespaced token so it reads
// as "the loading-content pointer" without colliding with the schema's one reserved
// pointer type (`um:agentDelegation`, which triggers the agentDelegationPointer $def).
export const LOADING_POINTER_TYPE = "um:loadingPointer";

// ===========================================================================
// AvatarDefinition — the v0.4 avatar-FACET-shaped interface.
// ===========================================================================
//
// An AvatarDefinition is the demo's portable, standards-facing description of the
// crossing user's avatar (variant + equipment + a pose reference), expressed so it
// becomes a v0.4 `um:Facet` with a single normalization step in the emitter.
//
// Field contract (what a producer — e.g. avatar layer — supplies):
//
//   avatarId        string   REQUIRED. Stable avatar identifier (maps to facet @id
//                            after URN-normalization, and is echoed in the facet body).
//   variant         string   REQUIRED. Avatar variant key (e.g. "default", a rig id).
//   displayName     string   OPTIONAL. Human label (NOT PII-load-bearing for the demo).
//   equipmentProfile string|null OPTIONAL. The equipment profile id/name the avatar wears.
//   equippedItems   array    OPTIONAL. Equipment items crossing with the avatar. Each item
//                            is passed through opaquely (the demo's existing equippedItems
//                            shape); the interface does not re-specify item internals.
//   poseRef         string|null OPTIONAL. A reference/pointer to the pose snapshot (kept a
//                            REFERENCE, not an inline pose — the rich pose lives in the
//                            demo's own labeled payload / geopose SDU, not the facet body).
//   requiredTrustTier integer(0..3) OPTIONAL. v0.4 per-facet trust floor (schema.json
//                            $defs/facet.requiredTrustTier). Omit for tier-0 (default).
//
// RECONCILIATION WITH provisional AvatarParams (seam note):
//   As of this change landing, result has
//   NOT landed, so its `AvatarParams` shape is not yet fixed. This interface is the
//   contract should map ONTO. The expected mapping (to be confirmed when 126
//   lands) is:
//       AvatarParams.id / avatarId            -> AvatarDefinition.avatarId
//       AvatarParams.variant / preset / rig   -> AvatarDefinition.variant
//       AvatarParams.displayName / name       -> AvatarDefinition.displayName
//       AvatarParams.equipmentProfile         -> AvatarDefinition.equipmentProfile
//       AvatarParams.equippedItems / items    -> AvatarDefinition.equippedItems
//       AvatarParams.pose / poseRef           -> AvatarDefinition.poseRef (as a REFERENCE)
//   `fromAvatarParams()` below implements that tolerant mapping so the seam closes the
//   moment 126 lands, accepting either the AvatarDefinition field names or the likely
//   AvatarParams aliases. If 126's landed shape differs, adjust ONLY this one adapter.
//
export const AVATAR_DEFINITION_CONTRACT = Object.freeze({
  interface: "AvatarDefinition",
  version: "runtime-v1",
  targets: "Universal Manifest v0.4 um:Facet (spec/v0.4/schema.json $defs/facet)",
  facet_type: UM_FACET_TYPE,
  required: ["avatarId", "variant"],
  optional: [
    "displayName",
    "equipmentProfile",
    "equippedItems",
    "poseRef",
    "requiredTrustTier",
  ],
  binds: "runtime (parametric avatars, web/avatar/) maps AvatarParams -> AvatarDefinition",
  scope_note:
    "structural facet contract only; conforming makes the emitted facet v0.4-shaped, " +
    "NOT a UM conformance claim (that is runtime/117b/119; um_conformance stays false).",
});

/** Build an AvatarDefinition from explicit fields (validates + normalizes defaults). */
export function makeAvatarDefinition(fields) {
  const f = fields && typeof fields === "object" ? fields : {};
  const def = {
    avatarId: str(f.avatarId),
    variant: str(f.variant),
    displayName: optStr(f.displayName),
    equipmentProfile: f.equipmentProfile == null ? null : str(f.equipmentProfile),
    equippedItems: Array.isArray(f.equippedItems) ? f.equippedItems.slice() : [],
    poseRef: f.poseRef == null ? null : str(f.poseRef),
    requiredTrustTier: normTier(f.requiredTrustTier),
  };
  return def;
}

/**
 * Tolerant adapter's (provisional) AvatarParams to AvatarDefinition.
 * Accepts either the AvatarDefinition field names OR the likely AvatarParams aliases
 * documented in the reconciliation note above. This is the ONE place to adjust when
 * result lands and its real shape is known.
 */
export function fromAvatarParams(avatarParams) {
  const p = avatarParams && typeof avatarParams === "object" ? avatarParams : {};
  return makeAvatarDefinition({
    avatarId: p.avatarId ?? p.id ?? p.avatar_id ?? null,
    variant: p.variant ?? p.preset ?? p.rig ?? p.avatar_variant ?? null,
    displayName: p.displayName ?? p.name ?? p.display_name ?? null,
    equipmentProfile: p.equipmentProfile ?? p.equipment_profile ?? null,
    equippedItems: p.equippedItems ?? p.items ?? p.equipped_items ?? [],
    poseRef: p.poseRef ?? p.pose_ref ?? (typeof p.pose === "string" ? p.pose : null),
    requiredTrustTier: p.requiredTrustTier ?? p.required_trust_tier ?? undefined,
  });
}

/**
 * Validate an AvatarDefinition SHAPE. Returns { valid, errors[] }. Structural only —
 * this is the contract check can run to confirm it produced a bindable object.
 */
export function validateAvatarDefinition(def) {
  const errors = [];
  if (!def || typeof def !== "object") {
    return { valid: false, errors: ["AvatarDefinition must be an object"] };
  }
  if (!isNonEmptyString(def.avatarId)) errors.push("avatarId: required non-empty string");
  if (!isNonEmptyString(def.variant)) errors.push("variant: required non-empty string");
  if (def.displayName != null && typeof def.displayName !== "string") {
    errors.push("displayName: must be a string when present");
  }
  if (def.equipmentProfile != null && typeof def.equipmentProfile !== "string") {
    errors.push("equipmentProfile: must be a string or null");
  }
  if (def.equippedItems != null && !Array.isArray(def.equippedItems)) {
    errors.push("equippedItems: must be an array when present");
  }
  if (def.poseRef != null && typeof def.poseRef !== "string") {
    errors.push("poseRef: must be a string or null");
  }
  if (def.requiredTrustTier != null && !isTier(def.requiredTrustTier)) {
    errors.push("requiredTrustTier: must be an integer 0..3 when present");
  }
  return { valid: errors.length === 0, errors };
}

// ===========================================================================
// LoadingPointer — the v0.4 pointer-shaped interface.
// ===========================================================================
//
// A LoadingPointer is the demo's portable reference to the DESTINATION's loading
// content (the thing the arriving world loads for the user). It is expressed so it
// becomes a v0.4 `pointer` (schema.json $defs/pointer) with a single normalization
// step in the emitter.
//
// v0.4 pointer contract: `@type` REQUIRED (non-empty string); `target`, `@id`,
// `label`, `createdAt`, `expiresAt` OPTIONAL. This interface maps to a PLAIN pointer
// (NOT `um:agentDelegation`, so the agentDelegationPointer $def is not triggered).
//
// Field contract (what a producer — e.g. loading-content track — supplies):
//
//   target      string|null OPTIONAL. The loading-content URL/URI. In the demo this
//                           is typically the destination's loading content, and if the
//                           destination delivers it via the IWPS `downloadUrl`,
//                           this points at that. Maps to pointer.target.
//   pointerId   string|null OPTIONAL. Stable pointer id (maps to pointer.@id after
//                           URN-normalization).
//   label       string|null OPTIONAL. Human label (maps to pointer.label).
//   expiresAt   string|null OPTIONAL. ISO 8601 expiry of the loading reference (maps to
//                           pointer.expiresAt). When omitted, the emitter may inherit the
//                           manifest's expiresAt.
//   pointerType string      OPTIONAL. Override the pointer @type. Defaults to
//                           LOADING_POINTER_TYPE ("um:loadingPointer"). MUST NOT be
//                           "um:agentDelegation" here (that is a different, delegation
//                           pointer with its own required fields).
//
export const LOADING_POINTER_CONTRACT = Object.freeze({
  interface: "LoadingPointer",
  version: "runtime-v1",
  targets: "Universal Manifest v0.4 pointer (spec/v0.4/schema.json $defs/pointer)",
  pointer_type: LOADING_POINTER_TYPE,
  required: [], // v0.4 pointer only structurally requires @type, which the emitter supplies
  optional: ["target", "pointerId", "label", "expiresAt", "pointerType"],
  binds: "runtime (loading-content) supplies the destination loading URL (e.g. IWPS downloadUrl)",
  scope_note:
    "structural pointer contract only; conforming makes the emitted pointer v0.4-shaped, " +
    "NOT a UM conformance claim (um_conformance stays false).",
});

/** Build a LoadingPointer from explicit fields (validates + normalizes defaults). */
export function makeLoadingPointer(fields) {
  const f = fields && typeof fields === "object" ? fields : {};
  const pointerType = isNonEmptyString(f.pointerType) ? f.pointerType : LOADING_POINTER_TYPE;
  return {
    pointerType,
    target: f.target == null ? null : str(f.target),
    pointerId: f.pointerId == null ? null : str(f.pointerId),
    label: f.label == null ? null : str(f.label),
    expiresAt: f.expiresAt == null ? null : str(f.expiresAt),
  };
}

/**
 * Validate a LoadingPointer SHAPE. Returns { valid, errors[] }. Structural only.
 * Enforces the one guardrail that keeps it a PLAIN v0.4 pointer: pointerType MUST NOT
 * be "um:agentDelegation" (that shape has its own required delegation fields).
 */
export function validateLoadingPointer(ptr) {
  const errors = [];
  if (!ptr || typeof ptr !== "object") {
    return { valid: false, errors: ["LoadingPointer must be an object"] };
  }
  if (!isNonEmptyString(ptr.pointerType)) {
    errors.push("pointerType: required non-empty string (defaults to um:loadingPointer)");
  } else if (ptr.pointerType === "um:agentDelegation") {
    errors.push(
      "pointerType MUST NOT be um:agentDelegation for a LoadingPointer (that is a delegation pointer)"
    );
  }
  if (ptr.target != null && typeof ptr.target !== "string") errors.push("target: must be a string or null");
  if (ptr.pointerId != null && typeof ptr.pointerId !== "string") errors.push("pointerId: must be a string or null");
  if (ptr.label != null && typeof ptr.label !== "string") errors.push("label: must be a string or null");
  if (ptr.expiresAt != null && !isIsoDateTime(ptr.expiresAt)) {
    errors.push("expiresAt: must be an ISO 8601 date-time string or null");
  }
  return { valid: errors.length === 0, errors };
}

// ===========================================================================
// Shared shape helpers (local, no cross-file coupling).
// ===========================================================================
function str(v) {
  return v == null ? "" : String(v);
}
function optStr(v) {
  return v == null ? null : String(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isTier(v) {
  return Number.isInteger(v) && v >= 0 && v <= 3;
}
function normTier(v) {
  return isTier(v) ? v : undefined;
}
function isIsoDateTime(v) {
  if (typeof v !== "string" || v.length === 0) return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}
