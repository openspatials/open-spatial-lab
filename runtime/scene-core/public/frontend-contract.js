/**
 * FrontendContract — Lane 1 typed integration contract.
 *
 * This is the contract this prototype EXPOSES DOWNSTREAM (consumed by the
 * integration assembly). It is authored verbatim from the
 * done-done PRD Section 14, Lane 1, and is exported both as runtime constants
 * (for the fixture adapter / UI to validate against) and as a JSDoc typedef.
 *
 * Source of truth:
 *
 * CLAIM CEILING (do not upgrade): UI-level only. This contract cannot assert
 * anything about server truth. Rendering is via Three.js FALLBACK verifier,
 * never first-party TeleportXR browser rendering.
 *
 * @typedef {"source"|"target"} WorldRole
 *
 * @typedef {Object} FrontendContract
 * @property {Object} inputs                               Inputs the frontend consumes.
 * @property {(role: WorldRole) => void} inputs.worldView  Render the world for a role.
 * @property {Object} inputs.avatarPose                    { position:[x,y,z], rotation_y:number }.
 * @property {Object} inputs.portalState                   { portal_id, trigger:{position, radius_m}, active:boolean }.
 * @property {Object} inputs.handoffStatus                 { phase, handoff_id, ... } — see HANDOFF_PHASES.
 * @property {Object} inputs.resetSignal                   { requestedAt:number }.
 *
 * @property {Object} expects_from_backend What Lane 3 must supply.
 * @property {string} expects_from_backend.runtimeStateStream  WS /runtime-state (fixture-simulated here).
 * @property {string} expects_from_backend.wowProjections      GET /wow/world, /wow/portal/{id}, /wow/user/{id}.
 *
 * @property {Object} expects_from_avatar_lane What Lane 2 must supply.
 * @property {Object} expects_from_avatar_lane.pose        { position, rotation_y, orientation, scale }.
 * @property {string} expects_from_avatar_lane.continuityId Preserved continuity subject id.
 * @property {Object} expects_from_avatar_lane.handoffIntent HandoffIntent payload (see handoff-packet fixture).
 *
 * @property {Object} emits                                What the frontend emits upstream.
 * @property {Object} emits.operatorControlEvents          { type, role, at } operator actions.
 * @property {Object} emits.resetRequest                   { role, at } reset request.
 */

export const FRONTEND_CONTRACT = Object.freeze({
  components: "1-frontend",
  version_id: "runtime",
  claim_ceiling: "UI-level only; cannot assert server truth; Three.js fallback rendering, not first-party TeleportXR render.",
  inputs: Object.freeze([
    "worldView(role: 'source'|'target')",
    "avatarPose",
    "portalState",
    "handoffStatus",
    "resetSignal",
  ]),
  expects_from_backend: Object.freeze([
    "runtimeStateStream (WS /runtime-state)",
    "/wow projections (/wow/world, /wow/portal/{portalId}, /wow/user/{userId})",
  ]),
  expects_from_avatar_lane: Object.freeze([
    "pose",
    "continuityId",
    "handoffIntent",
  ]),
  emits: Object.freeze([
    "operatorControlEvents",
    "resetRequest",
  ]),
});

/**
 * The four proof-boundary flags that MUST appear on every payload the frontend
 * renders. The UI asserts these are present-and-correct on every fixture load;
 * a missing/incorrect flag is a hard FAIL (guards the "unlabeled fixture read
 * as live" failure mode). Traced to PRD Section 8.3.
 */
export const PROOF_BOUNDARY_FLAGS = Object.freeze({
  application_level_handoff: true,
  native_teleportxr_teleport: false,
  first_party_teleportxr_browser_rendering: false,
  standards_conformance: false,
});

/**
 * Handoff lifecycle phases the frontend renders. The A/B role-state acceptance
 * from the PRD is encoded as: source travels idle -> portal_active -> departed
 * and STAYS on location-a; target travels waiting -> arrived and STAYS on
 * location-b. The two roles never converge on the same location.
 */
export const HANDOFF_PHASES = Object.freeze({
  // shared
  IDLE: "idle",
  // source-only
  PORTAL_ACTIVE: "portal_active",
  DEPARTED: "departed",
  // target-only
  WAITING: "waiting",
  ARRIVED: "arrived",
});

/**
 * Data-provenance labels. Every value surfaced in the UI is tagged with one of
 * these so a reviewer can never mistake fixture data for live server truth.
 * Traced to the task claim boundary ("label all data provenance").
 */
export const PROVENANCE = Object.freeze({
  SOURCE_PROVEN: "source-proven",
  SIMULATED: "simulated",
  FIXTURE: "fixture",
  REFERENCE: "reference",
  LIVE: "live",
});

/**
 * Validate that a payload carries the four proof-boundary flags exactly.
 * Returns { ok:boolean, problems:string[] }.
 */
export function validateProofBoundary(claimBoundary) {
  const problems = [];
  if (!claimBoundary || typeof claimBoundary !== "object") {
    return { ok: false, problems: ["claim_boundary block missing entirely"] };
  }
  for (const [k, expected] of Object.entries(PROOF_BOUNDARY_FLAGS)) {
    if (!(k in claimBoundary)) {
      problems.push(`missing flag: ${k}`);
    } else if (claimBoundary[k] !== expected) {
      problems.push(`flag ${k} is ${claimBoundary[k]}, expected ${expected}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
