// the scoped `um_conformance` descriptor (single source of truth).
//
// This is the object the demo surfaces as `proof_boundary.um_conformance`. It mirrors the
// SCOPED-true pattern of web/iwps-query-teleport.mjs (IWPS_CONFORMANCE) and
// web/geopose-basic-sdu.mjs (GEOPOSE_CONFORMANCE): a precisely-bounded truth object, NOT a
// bare boolean, worded so it CANNOT be read as a full-conformance or a v0.4 claim.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A LEGITIMATE false -> scoped-true (read before touching the labels)
// ---------------------------------------------------------------------------
// The flip is backed by a re-runnable, network-free gate — web/conformance/run-um-conformance.mjs —
// which drives the Universal Manifest repo's OWN conformance runner
// () over the v0.1 accept/reject
// matrix (conformance/v0.1/expected.json), using this demo's adapter (web/conformance/adapter.mjs,
// which reuses the UM repo's OWN reference validators). The gate proves:
//   - the runner ACCEPTS all 21 valid v0.1 fixtures (including the RP1 spatial-fabric stub),
//   - the runner REJECTS all 11 invalid v0.1 fixtures,
//   - the runner's determineConformanceLevel() computes exactly "v0.1-baseline",
//   - and the demo's OWN v0.4 manifest, down-adapted to v0.1 (web/conformance/um-v01-down-adapter.mjs),
//     is accepted by both the adapter and the UM reference validator.
// A reviewer re-runs that gate independently before accepting the flip (same discipline as
// GeoPose/IWPS). If the gate does not fully pass, this flag MUST go back to false.
//
// ---------------------------------------------------------------------------
// THE EXACT BOUNDARY (what is TRUE here, and what stays FALSE)
// ---------------------------------------------------------------------------
//   conformance_level     : "v0.1-baseline"  — the ONE hostable, machine-emitted level the
//                            UM runner can actually issue (its determineConformanceLevel tops
//                            out at v0.2-extended; there is NO v0.4 level in the runner code,
//                            its report/status JSON schemas, or its badge assets).
//   passes_runner_matrix  : true  — the v0.1 accept/reject matrix passes (proven by the gate).
//   badge                 : "v0.1-baseline" — conformance/badges/v0.1-baseline.svg exists.
//   evaluator_conformance : false — the v0.4 six-stage evaluator + structured um:Receipt is a
//                            SEPARATE, non-runner mechanism. NOT claimed here.
//   v04_baseline          : false — there is no hostable v0.4 badge yet (upstream gap, a
//                            concrete RP1/UM collaboration contribution, not a demo claim).
//   full_conformance      : false — a v0.1-baseline structural pass is NOT the whole UM
//                            conformance program. STAYS FALSE, exactly like GeoPose/IWPS.
//
// So `um_conformance` is a SCOPED true object labeled EXACTLY "v0.1-baseline (UM conformance
// runner)". It does NOT imply v0.4 and does NOT imply full conformance.

// The EXACT scoped label the task mandates. This is the string the UI panel + wire surface.
export const UM_CONFORMANCE_LEVEL_LABEL = "v0.1-baseline (UM conformance runner)";

export const UM_CONFORMANCE = Object.freeze({
  standard: "Universal Manifest",
  // The one hostable conformance level the UM runner actually emits for the demo. EXACT label.
  conformance_level: UM_CONFORMANCE_LEVEL_LABEL,
  // The demo's manifest + the v0.1 suite pass the UM runner's accept/reject matrix. TRUE,
  // proven by web/conformance/run-um-conformance.mjs (re-runnable, network-free).
  passes_runner_matrix: true,
  // The badge that legitimately exists for this level.
  badge: "v0.1-baseline",
  // What the runner scores against.
  matrix: "conformance/v0.1/expected.json (21 valid accepted, 11 invalid rejected)",
  runner: "universalmanifest/conformance/runner (determineConformanceLevel === v0.1-baseline)",
  // v0.4 EVALUATOR conformance (six-stage receipt) is a separate mechanism —. NOT here.
  evaluator_conformance: false,
  // No hostable v0.4 badge exists in the runner yet — NOT claimed.
  v04_baseline: false,
  // v0.1-baseline is not the whole UM conformance program. STAYS FALSE (like GeoPose/IWPS).
  full_conformance: false,
  // The one-line scoped claim, worded so it cannot be read as v0.4 or full conformance.
  claim:
    "Universal Manifest v0.1-baseline: passes the UM conformance runner's v0.1 accept/reject " +
    "matrix (the demo's own manifest + all v0.1 fixtures). NOT v0.4, NOT evaluator conformance, " +
    "NOT full conformance.",
});

// One-line human label the UI std-um panel prints. Kept beside the descriptor so the panel
// and the wire never drift.
export const UM_CONFORMANCE_LABEL =
  "um_conformance: v0.1-baseline ✓ (UM conformance runner; v0.1 accept/reject matrix) · " +
  "evaluator/v0.4:false · full UM conformance:false";
