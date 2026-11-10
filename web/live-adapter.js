import { projectLiveDebug, projectApiPanel } from "./live-adapter-debug.mjs";
import { fetchLiveApiEndpoint, postPresenterExit, postPresenterArrival } from "./live-adapter-operator.mjs";
import { MOVE_SPEED_MPS, facingSemanticsFromDelta, runCalibrationSnapshot, runCalibration, applyRunCalibration, movementFrame, stepLegacyMovement } from "./live-adapter-movement.mjs";
import { resolveAvatarGround, publishGroundSurface, restoredAvatarPose, localWalkState } from "./live-adapter-movement-ground.mjs";
import { runtimeLocomotion, publishRuntimeGroundMotion, stepRuntimeMovement } from "./live-adapter-movement-runtime.mjs";
import { snapshotVisualState, visualRuntimeProjection, visualDebugProjection, restoreVisualState } from "./live-adapter-visual-projection.mjs";
import { bindLivePresence } from "./live-adapter-presence-binding.mjs";
import { clientSceneWorld, clientScenePreview, clientSceneControls } from "./live-adapter-client-scene-projection.mjs";
import { initialSessionControls } from "./live-adapter-session-controls.mjs";
import { deriveFabricExitPose, counterpartExitPose } from "./live-adapter-navigation-exit-pose.mjs";
import { adoptHostedPortalPose, adoptHostedTargetPortalPose, adoptDestinationPortalPose } from "./live-adapter-navigation-portal-pose.mjs";
import { projectWorldNavigator, navigatorSpawn, endpointPreview, updateNavigatorMarker } from "./live-adapter-navigation-projection.mjs";
import { readNavigationDestination, readNavigationResources, promotionRecord } from "./live-adapter-world-navigation.mjs";
import {
  authoredWowGraphEndpoint, resolveEndpoints as resolveWowEndpoints,
} from "./live-adapter-world-discovery.mjs";
import { readWorld, readSceneGraph, readGraph, walkCanonicalGraph, readRootFabric, readPortals } from "./live-adapter-world-reader.mjs";
/**
 * LiveAdapter — Integration Assembly.
 *
 * Adapter for the LIVE Lane 3 backend. Public surface consumed by app.js: .world, .mode, init(),
 * claimBoundary(),
 * boundaryStatus(), activatePortal(), triggerHandoff(), applyArrival(), returnToLobby(), reset(),
 * listenForCrossWindow(), debugState(), and the "state" CustomEvent).
 *
 * Live wiring (BackendContract, Lane 3):
 *   - init():           WoW endpoints RESOLVED from the loaded fabric's
 *                       services[]: GET {base}/fabric.json ->
 *                       /wow/world, /wow/user/1, /wow/portal/1 (spec INTEGER
 *                       routes; the pre-097 hardcoded bases + string aliases
 *                       remain only as fallback when a manifest omits services)
 *   - runtime stream:   WS   {base}/runtime-state  (best-effort; see Lane 3 boundary)
 *   - source depart:    POST {baseA}/portal/exit-intent  -> real handoff packet
 *   - target arrival:   POST {baseB}/portal/arrival       -> applies real arrival
 *   - live pose lane:   BroadcastChannel "wow-teleportxr-integration-lane5"
 *                       type:"player-pose": the player broadcasts a
 *                       THROTTLED pose; the SAME-location observer mirrors it
 *                       onto its ONE existing avatar (render-only, no backend
 *                       request, never a second avatar).
 *
 * Correlation is ALWAYS by handoff_id (never by a scalar arrival_count delta —
 * the T-R3 measurement-artifact trap Lane 3 characterized). arrival_count is
 * displayed as-is from the live /debug/state but is NOT used as a correlation key.
 *
 * PROVENANCE: because this adapter reflects REAL server truth, it labels state
 * `live` (unlike the fixture adapter, which is forbidden from emitting `live`).
 * The four proof-boundary flags still come straight from the backend /wow payload
 * and are validated on load.
 *
 * CLAIM BOUNDARY: still application-level around TeleportXR; the browser render is
 * still Lane 1's Three.js FALLBACK verifier; native_teleportxr_teleport:false;
 * standards_conformance:false. Integration upgrades no claim.
 */



import {
  HANDOFF_PHASES,
  PROVENANCE,
  validateProofBoundary,
} from "./vendor/scene-core/frontend-contract.js";
import {
  defaultEquippedItems,
  equipmentCatalog,
  resolveEquipmentItems,
  validateEquippedItems,
} from "./equipment-view.js";
// step 5: the runtime-switchable avatar variant set lives in
// the visual layer (single source of truth); the adapter carries the KEY.
import { AVATAR_VARIANTS, DEFAULT_AVATAR_VARIANT } from "./avatar-equipment-layer.js";
// route the same-origin proxy bases through the ONE base-path helper so the
// whole HTTP surface (every `${proxy_base}/…` fetch built from ENDPOINTS below) resolves beneath
// the public prefix in subpath mode, and is byte-for-byte identical in root mode.
import { apiBase, serverRootUrl, BASE_PATH, SERVER_ORIGIN } from "./base-path.mjs";
import { worldEndpoints } from "./worlds-list.mjs";
// the OGC GeoPose 1.0 Basic-YPR/Quaternion SDU builder lives in a
// SHARED leaf module so the exact object emitted here is the exact object the
// network-free schema validator (web/geopose-schema-conformance-check.mjs)
// validates against the official OGC JSON Schemas — no second copy to drift.
import {
  geoPoseShapedFromTransform,
} from "./geopose-basic-sdu.mjs";
// the OMA3 IWPS v0.3 Query+Teleport re-shape lives in a SHARED leaf
// module so the IWPS vocabulary READING of the crossing (camelCase keys, kebab-case URLs,
// opaque `location`, teleportId==handoff_id) and the HONEST-FALSE conformance descriptor
// are one source of truth for the adapter, the UI and the e2e — no drift.
// that reading is POST-HOC. It is NOT "the on-the-wire IWPS
// vocabulary" — the wire is demo-native snake_case and carries no IWPS parameter at all.
import {
  IWPS_CONFORMANCE,
} from "./iwps-query-teleport.mjs";
// `um_conformance` is a SCOPED true object (v0.1-baseline via the
// Universal Manifest conformance runner), not a bare false. The descriptor is the single
// source of truth; it is BACKED by web/conformance/run-um-conformance.mjs, which drives the
// UM repo's OWN runner over the v0.1 accept/reject matrix (21 valid accepted, 11 invalid
// rejected -> conformanceLevel "v0.1-baseline") and confirms the demo's own down-adapted
// manifest is accepted. NOT v0.4, NOT evaluator conformance, NOT full conformance.
import { UM_CONFORMANCE } from "./conformance/um-conformance.mjs";

import {
  DEFAULT_LIVE_ADAPTER_TRANSPORT,
  displayPath,
} from "./live-adapter-transport.mjs";
export { API_EVENTS } from "./live-adapter-transport.mjs";
import {
  clamp,
  clonePosition,
  cloneScale,
  fabricPortalKey,
  mapCameraBetweenPortalFrames,
  normalizePortalTraversal,
  portalEntrySideAllowed,
  portalFrameForLocation,
  roundNumber,
  roundVec3,
  yawQuaternion,
} from "./live-adapter-portal-geometry.mjs";
export { mapCameraBetweenPortalFrames } from "./live-adapter-portal-geometry.mjs";
import {
  worldFromLive,
  wowWorldSpatialId,
} from "./live-adapter-world-projection.mjs";
import {
  checkCrossing,
  poseOfMatrix,
  portalSignature,
  resolveBoundedPreview,
} from "./main-demo-portals.mjs";
import { arrivalAt } from "./wow-portal.mjs";
import {
  PRESENCE_TIMING,
} from "./live-adapter-presence-controller.mjs";
import {
  PEER_PRESENCE_TIMING,
} from "./live-adapter-peer-presence-reducer.mjs";
import { bindFabricPrefetch, installFabricPrefetchViews } from "./live-adapter-prefetch-binding.mjs";
import { bindClientScene } from "./live-adapter-client-scene-binding.mjs";
import { bindPortalTraversal } from "./live-adapter-traversal-binding.mjs";
import { automaticReciprocalPortal } from "./airport-lobby-transition.mjs";
import {
  airportSurfaceBounds,
  createAirportWalkableSurfaceContract,
} from "./airport-walkable-surface.mjs";
// Compatibility ownership trace: worldFromLive now consumes
// clientSceneLoadFieldsFromWowPortal.
export {
  portalEntryFromWowNode,
  portalEntryFromWowPortal,
} from "./live-adapter-world-projection.mjs";

import { RP1_FAIL_CLOSED, RP1_FAIL_CLOSED_MODES, demoModeToRp1Options, traversalRequestForDemoMode, gateChildScopeTraversal } from "./rp1-fail-closed.mjs";
import { buildRp1Section } from "./manifest/rp1-model.mjs";
import { verifyManifestProfileA as umIdentityVerifyManifest } from "./signing/um-signature-profile-a.mjs";
// Same-origin proxy paths served by src/serve.js (adds CORS, forwards to the
// LIVE Lane 3 backends without altering payloads). Using the
// proxy avoids cross-origin CORS blocks against Lane 3 (which is intentionally
// left unmodified — no auth/CORS by design). A page served apart from its world
// servers reaches the same proxy at their origin (web/base-path.mjs, SERVER_ORIGIN).
const BASE_A = apiBase("a");
const BASE_B = apiBase("b");
// the pre-location LOBBY — a real first-class location a
// player starts in when no server has been assigned (never an error state).
const BASE_LOBBY = apiBase("lobby");
// the authored airport is a real fourth backend. The
// frontend proxy already owns this route; the adapter now promotes it exactly
// like A/B instead of entering a fixture-backed client scene.
const BASE_AIRPORT = apiBase("airport");
const HOSTED_ATTACH_POINT_EVENT = "hostedattachpoint";
// floor between two `runtime-state tick` console lines.
// The stream itself is untouched; only how often its arrival is narrated is.
const RUNTIME_STATE_LOG_INTERVAL_MS = 5000;
const ENDPOINTS = worldEndpoints();

// The lab's own walk and run, used only until the avatar runtime gives its tuning (setAvatarLocomotionTuning) and for an
// avatar outside the runtime. The runtime's Locomotion moves every avatar of the roster at its own clips' pace (walk
// 1.06 to 1.15 m/s, jog 4.8 to 5.0 m/s for the four collection avatars), so the feet do not race or float.






// CONTINUOUS seamless crossing — the winning Demo-A
// controller's walk-through, grafted into the live World Navigator.
// (no walk-to-center, no control seizure, no held pose, no shrink, no hide).
// The player simply KEEPS WALKING: when the avatar's sampled position crosses
// the portal PLANE inside the oval (front -> back sign change, detected in
// _updatePortalStatus), the crossing commits on that same tick. The single
// remaining transition phase 'portal_walkthrough' marks the commit-in-flight
// beat (the few frames while the exit-intent/arrival notifications post);
// during it the avatar keeps drifting along its entry heading at walk speed so
// the motion never halts. On commit the REAL game camera is remapped through
// the source->target portal frames RELATIVE TO THE AVATAR
// (mapCameraAcrossCrossing — the Demo-A proper-rotation mapCrossing recipe),
// so "camera behind the avatar" stays behind after the crossing. The exported
// mapCameraBetweenPortalFrames API intentionally retains its distinct legacy
// preview-position convention in live-adapter-portal-geometry.mjs.
// live same-location pose continuity: the player broadcasts a THROTTLED
// `player-pose` message on the EXISTING lane5 channel — a ~15 Hz ceiling plus
// meaningful position/yaw deltas plus edge-triggered locomotion/transition
// flips. Never every frame.
// a peer player's pose is considered live for this long
// after its last packet. Beyond it the peer is treated as gone (its avatar is
// dropped) — guards against a closed/crashed peer tab leaving a ghost avatar.
// server-side presence registry. A PLAYER session
// explicitly registers/heartbeats/departs against its CURRENT active server
// (spawn -> register; crossing -> depart old + register new; tab close ->
// depart beacon) so each location's server knows its real players and
// /fabric/presence occupancy is server truth, not client mirroring. TTL on
// the server expires a crashed tab that never departs.

/* ---------------- Web of Worlds API identity ---------------
 * Transport, request telemetry, the shared sequence, and validation-header
 * accounting live in live-adapter-transport.mjs. This facade retains the exact
 * visible OpenAPI identity and re-exports the canonical API_EVENTS singleton.
 */
const SPEC_IDENTITY = Object.freeze({
  spec_file: "OpenSpatialWorld API.yaml",
  openapi: "3.0.4",
  shape_validation: "shape-validated 22/22",
  standards_conformance: false,
  identity_line:
    "OpenSpatialWorld API.yaml · openapi 3.0.4 · shape-validated 22/22 · standards_conformance:false",
});

function endpointKeyForRole(role, active) {
  const requested = String(active || "").toLowerCase();
  if (requested === "target" || requested === "b") return "b";
  if (requested === "source" || requested === "a") return "a";
  if (ENDPOINTS[requested]) return requested;
  // a PLAYER with no assigned server starts in the LOBBY
  // ("when a character is started up and they haven't been assigned to
  // a server yet, they are in their own lobby"). An explicit-but-unknown
  // `active` value and the observer roles keep their defaults.
  if (role === "player" && !requested) return "lobby";
  return role === "target" ? "b" : "a";
}

// The two demo worlds are each other's opposite ;
// the lobby has TWO destinations, so it has no single opposite — callers that
// need a preview/target endpoint for a multi-portal world must derive it from
// a specific portal instead (endpointKeyForLocation).
function oppositeEndpointKey(endpointKey) {
  if (endpointKey === "lobby") return null;
  if (endpointKey === "airport") return "lobby";
  if (endpointKey === "a") return "b";
  return endpointKey === "b" ? "a" : null;
}

/** resolve an ENDPOINTS key from a location_id (the
 *  stable identity — ports may be rebound by the e2e orchestrator). */
function endpointKeyForLocation(locationId) {
  const wanted = String(locationId || "");
  if (!wanted) return null;
  for (const key of Object.keys(ENDPOINTS)) {
    if (ENDPOINTS[key].location_id === wanted) return key;
  }
  return null;
}

function endpointDebug(endpoint, world) {
  return {
    endpoint_key: endpoint.endpoint_key,
    proxy_base: endpoint.proxy_base,
    backend_base_url: endpoint.backend_base_url,
    location_id: world && world.location_id ? world.location_id : endpoint.location_id,
    world_id: world && world.world_id ? world.world_id : endpoint.world_id,
    session_id: world && world.session_id ? world.session_id : endpoint.session_id,
  };
}

function strictProofBoundary(flags) {
  return {
    application_level_handoff: flags && flags.application_level_handoff === true,
    native_teleportxr_teleport: false,
    first_party_teleportxr_browser_rendering: false,
    standards_conformance: false,
    // SCOPED true (v0.1-baseline via the UM conformance runner), not a
    // bare false. Single source of truth = UM_CONFORMANCE; backed by the re-runnable gate
    // web/conformance/run-um-conformance.mjs. NOT v0.4, NOT evaluator, NOT full conformance.
    um_conformance: { ...UM_CONFORMANCE },
    // iwps_conformance is an HONEST-FALSE object.
    // A "scoped true" (base_query_teleport:true) would be an OVERCLAIM:
    // we are IWPS-SHAPED (two POSTs, Query->Teleport order, kebab-case, POST-only),
    // NOT IWPS-CONFORMANT: no IWPS parameter is on the wire, the destination implements
    // neither the Query (§5.3.2) nor the Teleport (§5.3.3) API, and the ack/nack callbacks
    // (§5.3.3 step 9, a SHALL) are never called. Single source of truth = IWPS_CONFORMANCE.
    iwps_conformance: { ...IWPS_CONFORMANCE },
    web_of_worlds_conformance: false,
    spatial_fabric_conformance: false,
  };
}

function makePlayerContextMarker() {
  const href = typeof window !== "undefined" && window.location ? window.location.href : "";
  let navigationType = "unknown";
  let navigationEntryCount = 0;
  try {
    const entries = typeof performance !== "undefined" && performance.getEntriesByType
      ? performance.getEntriesByType("navigation")
      : [];
    navigationType = entries && entries[0] && entries[0].type ? entries[0].type : "unknown";
    navigationEntryCount = entries ? entries.length : 0;
  } catch (e) {
    navigationType = "unknown";
  }
  // the marker is the World Navigator's in-memory session marker — one
  // browsing context ("tab") for the whole crossing. It is upgraded in place at
  // load with the fabrics composed into this single context.
  // `same_marker_after_crossing` starts null and is set ONLY by a real
  // captured-at-load vs read-after-crossing comparison (never hardcoded). A
  // full page reload would recreate this whole object (new random ids) and the
  // comparison would be null again — which is exactly what makes it a proof.
  return {
    marker_id: `player-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    marker_kind: "world_navigator_session_marker",
    context_id: `omb-ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    created_at: new Date().toISOString(),
    boot_href: href,
    current_href: href,
    navigation_type_at_boot: navigationType,
    navigation_entry_count_at_boot: navigationEntryCount,
    same_marker_after_crossing: null,
    crossing_comparison: null,
    single_context: true,
    fabrics_loaded: [],
    fabrics_loaded_count: 0,
    root_fabric_url: null,
    child_fabric_url: null,
    upgraded_at: null,
  };
}

/* ---------------- World Navigator: fabric-manifest helpers ------------
 * A world-server serves a "fabric manifest" (plain-JSON, unsigned, labeled —
 * claim boundary). The portal is a scene node with Type.bSubtype === 255 whose
 * Resource.sReference is the child fabric's URL; the trigger is a sibling node
 * with an "action:" resource. NOTE: in this project "MSF" always means
 * Metaverse Standards Forum, never a file format. */

/** ALL portal attachment nodes (an N-portal fabric — the
 *  lobby — carries one per portal; single-portal fabrics carry exactly one). */

function distance2d(a, b) {
  const dx = (a[0] || 0) - (b[0] || 0);
  const dz = (a[2] || 0) - (b[2] || 0);
  return Math.hypot(dx, dz);
}

function previewFreshnessMs(capturedAt) {
  if (!capturedAt) return null;
  const t = Date.parse(capturedAt);
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null;
}

/**
 * Freeze render-facing avatar values without duplicating live model ownership.
 * Plain data and arrays are copied recursively. Explicit identity/model/rig,
 * resource, controller, renderer, scene, and equipment-owner fields retain
 * their stable references; non-plain runtime objects are retained likewise.
 */
export function snapshotRenderFacingAvatar(avatar) {
  if (!avatar || typeof avatar !== "object") return avatar;
  const stableReferenceFields = new Set([
    "identity",
    "identity_handle",
    "model",
    "model_handle",
    "rig",
    "rig_handle",
    "resource",
    "resource_handle",
    "controller",
    "controller_handle",
    "renderer",
    "renderer_handle",
    "scene",
    "scene_handle",
    "equipment_owner",
    "equipment_owner_handle",
  ]);
  const copies = new WeakMap();
  const copyMutableValue = (value, field = null) => {
    if (!value || typeof value !== "object" || stableReferenceFields.has(field)) return value;
    if (copies.has(value)) return copies.get(value);
    if (Array.isArray(value)) {
      const copy = [];
      copies.set(value, copy);
      for (const item of value) copy.push(copyMutableValue(item));
      return copy;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const copy = {};
    copies.set(value, copy);
    for (const [key, item] of Object.entries(value)) {
      copy[key] = copyMutableValue(item, key);
    }
    return copy;
  };
  return copyMutableValue(avatar);
}

function transformSnapshot(avatar) {
  const rotationY = Number(avatar && avatar.rotation_y) || 0;
  return {
    position: clonePosition(avatar && avatar.position, [0, 0, 0]),
    rotation_y: rotationY,
    orientation: yawQuaternion(rotationY),
    scale: cloneScale(avatar && avatar.scale),
  };
}

// GeoPose Basic SDU construction.
//
// The builder `geoPoseShapedFromTransform()` lives in the SHARED leaf module
// web/geopose-basic-sdu.mjs (imported at the top of this file) so the object emitted
// on the wire is the exact object the network-free validator
// (web/geopose-schema-conformance-check.mjs) checks against the official OGC
// GeoPose 1.0 Basic-YPR/Quaternion JSON Schemas — one source, no drift.
//
// The claim is a SCOPED true: the emitted
// Basic-YPR + Basic-Quaternion SDUs are SCHEMA-VALID (structural/data conformance);
// `georeferenced` STAYS false (illustrative origin, flat local-tangent approximation,
// no geodetic anchor); full GeoPose conformance beyond the Basic-SDU schema STAYS
// false. See the SCOPE block in web/geopose-basic-sdu.mjs and GEOPOSE_CONFORMANCE.





// verify the SIGNED OpenUserManifest identity carried on the
// /wow/user response (`open_user_manifest`). The retained UM IDENTITY spine: a REAL
// Ed25519 signature over the JCS-RFC8785 canonical bytes of {name, age,
// avatarAssetURI}, bound to a did:key. Returns an HONEST state object — verified only
// when the byte-exact recompute + Ed25519 check pass; absent/failed signatures
// degrade to a labeled "unsigned / unverified" (never a cosmetic green). This is the
// identity spine, kept SEPARATE from the crossing-manifest signing (um_signing) and
// the .msf engine spine. standards_conformance stays false regardless of this result.
async function verifyUmIdentity(wowUser) {
  const oum = wowUser && wowUser.open_user_manifest;
  const label = wowUser && wowUser.open_user_manifest_label ? wowUser.open_user_manifest_label : null;
  if (!oum || typeof oum !== "object") {
    return {
      present: false,
      verified: false,
      reason: "no-open-user-manifest",
      name: null,
      status_label: "unsigned / unverified (no UM identity on /wow/user)",
      server_label: label,
    };
  }
  const base = {
    present: true,
    name: typeof oum.name === "string" ? oum.name : null,
    age: typeof oum.age === "number" ? oum.age : null,
    avatarAssetURI: typeof oum.avatarAssetURI === "string" ? oum.avatarAssetURI : null,
    key_ref: oum.signature && oum.signature.keyRef ? oum.signature.keyRef : null,
    algorithm: oum.signature && oum.signature.algorithm ? oum.signature.algorithm : null,
    canonicalization: oum.signature && oum.signature.canonicalization ? oum.signature.canonicalization : null,
    server_label: label,
  };
  if (!oum.signature || !oum.signature.value) {
    return {
      ...base,
      verified: false,
      reason: "unsigned",
      status_label: "unsigned / unverified",
    };
  }
  try {
    // Verifies `oum.signature` over JCS(oum − signature) with the embedded SPKI key
    // + did:key keyRef consistency (byte-exact; the verify-vectors.mjs pattern).
    const detail = await umIdentityVerifyManifest(oum);
    return {
      ...base,
      verified: detail.ok === true,
      reason: detail.reason,
      checks: detail.checks,
      status_label: detail.ok
        ? "verified UM identity (Ed25519 / JCS-RFC8785 / did:key) — real signature; standards_conformance:false (non-canonical additive)"
        : `UNVERIFIED — signature present but verification failed (${detail.reason})`,
    };
  } catch (e) {
    return {
      ...base,
      verified: false,
      reason: `verify-threw:${(e && e.message) || "error"}`,
      status_label: "unverified (verifier error) — degraded honestly",
    };
  }
}

export class LiveAdapter extends EventTarget {
  constructor(role, opts = {}) {
    super();
    if (role !== "source" && role !== "target" && role !== "player") {
      throw new Error(`invalid role: ${role} (expected 'source'|'target'|'player')`);
    }
    this._transport = opts.transport || DEFAULT_LIVE_ADAPTER_TRANSPORT;
    this._portalAtomicityOracle = ["microtask", "task", "raf", "all"].includes(opts.portalAtomicityOracle)
      ? opts.portalAtomicityOracle
      : null;
    this.role = role;
    this.clientMode = role === "player" ? "player" : "observer";
    // when set (the demo boots with ?noequip=1), a fresh
    // avatar spawns with NO equipment (the clean base avatar). Absent/false =>
    // the historical default loadout, so every proof that boots WITHOUT the flag
    // (e2e-driver, rigged-avatar, equipment schema checks) is unchanged.
    this._noDefaultEquipment = !!opts.noDefaultEquipment;
    // the WoW CORE REQUIREMENT intent, parsed from the URL + hash
    // fragment (join | follow | preview) by web/wow-url.mjs and handed in by the boot hook in
    // app.js. It is READ-ONLY (the no-reload guard forbids writing URL/history).
    //
    // The ONLY thing it changes in this adapter is whether the session REGISTERS PRESENCE:
    //   join / follow -> registers (a real user in the world; spec: "as new or existing user")
    //   preview       -> does NOT  (spec: "experence world without" — the sentence is truncated
    //                    upstream; our reading is "without JOINING". See interpretation I5 in
    //                    web/wow-url.mjs.)
    //
    // Preview REUSES the adapter's existing non-registering client surface — the very same
    // `_presence.supported` gate that every observer window already runs under (see below). No
    // new session mode is invented and no presence machinery is rebuilt.
    this.wowIntent = opts.wowIntent || null;
    // `plain`: a portal crosses by plain web navigation instead of the seamless crossing (`&crossing=plain`).
    this._crossingProfile = opts.crossingProfile || null;
    this._wowRegistersPresence = this.wowIntent ? this.wowIntent.registersPresence !== false : true;
    this.wowFollowTarget = this.wowIntent ? (this.wowIntent.followTarget || null) : null;
    this.activeEndpointKey = endpointKeyForRole(role, opts.active);
    this.previewEndpointKey = role === "player" ? oppositeEndpointKey(this.activeEndpointKey) : null;
    this.endpoint = ENDPOINTS[this.activeEndpointKey];
    this.previewEndpoint = this.previewEndpointKey ? ENDPOINTS[this.previewEndpointKey] : null;
    this.base = this.endpoint.proxy_base;
    this.baseA = BASE_A;
    this.baseB = BASE_B;
    // URL/id-driven WoW world entry. When a WoW
    // ref is supplied (?wow=<url|id>), the browser opens THAT world by fetching
    // its Spatial Composition Graph (initWow) and rendering it through the
    // additive buildWowScene seam. Absent => the role/world behavior.
    this.wowRef = opts.wowRef || null;
    this._wowResolved = null;
    // the crossing's SCENE SOURCE OF RECORD: the active
    // world's WoW Spatial Composition Graph (/wow/spatial/{id}) resolved via the
    // canonical walk, as the destination scene source. Best-effort + non-fatal.
    // Surfaced in debugState().wow_scene_source (honest, never hidden). Null
    // before the first resolve.
    this._wowSceneSource = null;
    // local-walk (fixture ?wow=) flags. `_movementBounds`
    // is null on the live path, so stepAvatar's clamp stays byte-identical
    // ±WORLD_LIMIT; when a WoW world is walked it holds the per-world walkable
    // clamp MEASURED from the world's actual content extent (project lesson:
    // measure per world, do not hardcode). `_wowLocalWalk` neutralizes the
    // live-only /movement POST + observer pose broadcast for a client-local walk
    // that has no live backend / presence / WS.
    this._movementBounds = null;
    this._wowLocalWalk = false;
    this._airportWalkableSurface = null;
    // session-local run calibration. Null preserves the characterized
    // measured 2.8 m/s source path until the UI installs
    // the exact source-derived cycle values after the real run clip loads.
    this._runCalibration = null;
    this.mode = "live"; // <-- the integration is LIVE, not fixture
    this.world = null;
    this._startsEmbodied = role === "source" || role === "player";
    this.state = {
      phase: this._startsEmbodied ? HANDOFF_PHASES.IDLE : HANDOFF_PHASES.WAITING,
      handoff_id: null,
      arrival_count: 0,
      avatar: null,
      equipment_status: null,
      preview: null,
      // per-portal previews for multi-portal worlds
      // (keyed by fabricPortalKey; null on single-portal worlds).
      portal_previews: null,
      _provenance: PROVENANCE.LIVE,
      controls: initialSessionControls(this._startsEmbodied, "init"),
      last_handoff_direction: null,
      last_handoff_payload: null,
      last_pose_payload: null,
      player_handoff_profile: null,
    };
    this._boundaryOk = false;
    this._boundaryProblems = [];
    this._portalId = this.endpoint.portal_id;
    this._jumpVelocity = 0;
    this._serverSyncMs = 0;
    this._nonPortalHandoffInFlight = false;
    // latest visibility record PER PEER WINDOW (client_id ->
    // { location_id, visible_avatar_count }). Peers are filtered against the
    // CURRENT world at READ time (not receipt time) so an active-world switch
    // (fabric promotion) never leaves a stale cross-location count behind.
    this._clientId = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // live pose lane bookkeeping. Player side: throttled `player-pose`
    // broadcast state. Observer side: the last received same-location live pose
    // (render-only mirror metadata, never a backend mutation).
    // player presence: latest pose received from OTHER
    // player windows (client_id -> peer pose snapshot). Player views use this
    // for peer co-presence; observer/server views use the same keyed records to
    // render every player in the observer's current location. Same-origin lane5
    // BroadcastChannel is the transport - local same-machine proof, not
    // networking.
    this._playerContextMarker = role === "player" ? makePlayerContextMarker() : null;
    // frozen snapshot of the marker AT LOAD. The no-reload proof is a
    // REAL comparison of this snapshot against a read of the live in-memory
    // marker after the crossing (see _recordMarkerCrossingComparison).
    this._markerAtLoad = this._playerContextMarker
      ? Object.freeze({
          marker_id: this._playerContextMarker.marker_id,
          context_id: this._playerContextMarker.context_id,
          created_at: this._playerContextMarker.created_at,
          boot_href: this._playerContextMarker.boot_href,
          navigation_entry_count_at_boot: this._playerContextMarker.navigation_entry_count_at_boot,
        })
      : null;
    this._bootEndpointKey = this.activeEndpointKey;
    // World Navigator: one context, two fabrics (root + child at portal).
    this._navigator = null;
    this._childFabricManifest = null;
    this._rootFabricManifest = null;
    // World Navigator crossing: promotion is hosted here; traversal state
    // and evidence are owned by live-adapter-portal-traversal-controller.mjs.
    this._navigatorPromotions = [];
    this._lastCameraTransform = null;
    // the renderer and rAF camera keep reading one
    // immutable source-facing projection while destination transport and host
    // promotion stage internally. The projection is cleared synchronously in
    // the same browser turn that publishes the mapped avatar/camera/scene.
    this._visualTransitionSnapshot = null;
    // WoW endpoints RESOLVED from the loaded fabric's services[] (spec
    // integer routes) rather than hardcoded /api/{a,b} bases + string aliases.
    // Populated by _resolveWowEndpoints() on every world (re)load; the /wow/*
    // integer routes are the fallback when a manifest omits a service entry.
    this._wowEndpoints = null;
    this._wowEndpointResolution = null;
    this._viewMatch = null;
    this._rootFabricManifestUrl = null;
    // RP1 fail-closed gate state. demo_mode defaults "off" (happy path;
    // e2e unaffected); the crossing UI arms "stale-attachment" / "revoked-session" to make
    // the two fail-closed paths visible. last_receipt is the most recent traversal-gate
    // receipt (accepted on allow; REJECTED on a fail-closed deny). Surfaced in debugState().
    this._rp1FailClosed = { demo_mode: "off", last_receipt: null, allow_count: 0, deny_count: 0 };
    // the controller is the sole mutable owner of
    // prefetch machines, scheduling, cache, occupancy, proof/promotion state,
    // and paced completion. LiveAdapter keeps only cross-domain callbacks and
    // compatibility views; the controller has no traversal authority.
    this._fabricPrefetchController = bindFabricPrefetch({
      getJson: (url) => this._transport.getJson(url),
      resolveProxyBase: (address) => this._fabricProxyBaseForAddress(address),
      adoptDestinationPortalPose: (machine, pose) => this._adoptDestinationPortalPoseForMachine(machine, pose),
      onTargetSetChanged: () => { if (this._runtimeStreams) this._syncPresenceEventStreams(); },
      emitState: () => this._emit(), log: (message) => this._log(message),
      getActiveBase: () => this.base, getAvatarPose: () => this.state ? this.state.avatar : null,
    });
    installFabricPrefetchViews({
      defineProperty: (name, descriptor) => Object.defineProperty(this, name, descriptor),
      readController: () => this._fabricPrefetchController,
    });
    // server-side presence registration lifecycle. The
    // player_id is this window's client id (one player session = one window).
    // Registration targets ONLY this.base (the player's own active server) —
    // never the prefetch destination; prefetch presence reads stay GET-only.
    const presenceBindings = bindLivePresence({
      transport: this._transport, clientMode: this.clientMode, clientId: this._clientId,
      supported: this._wowRegistersPresence,
      getBase: () => this.base, getLocationId: () => this.world ? this.world.location_id : null,
      getAvatar: () => this.state.avatar || (this.world && this.world.avatar),
      getHandoffInFlight: () => this._nonPortalHandoffInFlight ||
        !!(this._portalTraversalController && this._portalTraversalController.inFlight()),
      onForcePose: (input) => this._maybeBroadcastPlayerPose(input),
      onCloseEventStreams: () => this._closePresenceEventStreams(),
      onLog: (message) => this._log(message),
      getPeerContext: () => ({ world: this.world, avatar: this.state.avatar,
        controls: this.state.controls, phase: this.state.phase, wowLocalWalk: this._wowLocalWalk }),
      onEmit: (input) => this._emit(input), onArrival: (packet) => this.applyArrival(packet),
      onDepartureMirror: (packet) => this._applyDepartureMirror(packet),
      onArrivalMirror: (packet) => this._applyArrivalMirror(packet),
      onEquipmentStatus: (status) => { this.state.equipment_status = status; },
      onExternalPresenceDeparture: (input) => this._applyPresenceDepartureProjections(input),
      getActiveEndpointKey: () => this.activeEndpointKey,
      getDesiredEventEndpointKeys: () => this._presenceEventEndpointKeys(),
      isEndpointKey: (key) => !!ENDPOINTS[key],
      onRuntimeState: (message) => this._observeRuntimeState(message),
      onPresenceDeparture: (key, message) => this._applyPresenceDeparture(key, message),
      onPresenceDepartureApplied: (record) => this._emitPresenceDeparture(record),
      fallbackPollMs: () => this.FABRIC_PREFETCH_PRESENCE_REFRESH_MS,
    });
    this._presenceController = presenceBindings.presence;
    this._peers = presenceBindings.peers;
    this._runtimeStreams = presenceBindings.streams;

    this._portalTraversalController = bindPortalTraversal({
      transport: {
        getJson: (url) => this._transport.getJson(url),
        postJson: (url, body) => this._transport.postJson(url, body),
      },
      nowMs: () => Date.now(),
      nowIso: () => new Date().toISOString(),
      readHostSnapshot: () => this._readTraversalHostSnapshot(),
      applyTraversalPatch: (patch) => this._applyTraversalHostPatch(patch),
      resolveEndpointForLocation: endpointKeyForLocation,
      oppositeEndpointKey,
      endpointDebug,
      promoteActiveEndpoint: async (targetKey, packet, isCurrent) => {
        const promotion = await this._promoteActiveEndpoint(targetKey, packet, isCurrent);
        return { promotion, destinationSceneSource: this._lastCrossingSceneSource || null };
      },
      deriveFabricExitPose: (frameMapping) => this._fabricDerivedExitPose(frameMapping),
      recordMarkerComparison: () => this._recordMarkerCrossingComparison(),
      previewDebug: () => this._previewDebug(),
      navigatorDebug: () => this._navigatorDebug(),
      broadcastPlayerPose: (input) => this.broadcastPlayerPose(input),
      emitState: () => this._emit(),
      dispatchCrossing: (detail) => this.dispatchEvent(new CustomEvent("crossing", { detail })),
      visualTransition: {
        begin: (input) => this.beginVisualTransition(input),
        commit: () => this.commitVisualTransition(),
        abort: (input) => this.abortVisualTransition(input),
      },
      portalAtomicityOracle: this._portalAtomicityOracle,
      crossingGate: (portal) => this._checkCrossing(portal),
      onCrossingRefused: (refusal) => {
        this._log(`crossing refused: ${refusal.reason}`);
        this.dispatchEvent(new CustomEvent("portal-refused", { detail: refusal }));
      },
      navigateTo: (url) => this.dispatchEvent(new CustomEvent("portal-navigate", { detail: { url } })),
      log: (message) => this._log(message),
      presence: {
        controlledIdentity: () => ({
          ...this.controlledIdentity(),
          player_id: this.controlledIdentity().player_id,
        }),
        snapshot: () => this.presenceSnapshot(),
        departPresence: (input) => this.departPresence(input),
        registerPresence: (input) => this.registerPresence(input),
      },
      peers: {
        broadcast: (message) => this._broadcast(message),
        clearLivePlayerPose: () => this._peers.clearLivePlayerPose(),
      },
      prefetch: {
        proofBlock: (commitIso, portalKey) => this._fabricPrefetchProofBlock(commitIso, portalKey),
      },
      policy: {
        evaluateRp1Gate: () => this._rp1GateCheck(),
      },
      getSigningWorld: () => this.world,
      getSigningTransport: () => this._transport,
      isDisposed: () => this._disposed === true,
      validation: { transformSnapshot },
      motionPreference: opts.motionPreference,
      movement: {
        speedMps: MOVE_SPEED_MPS,
        facingSemanticsFromDelta,
      },
    });

    this._clientSceneController = bindClientScene({
      nowIso: () => new Date().toISOString(),
      resolveClientGraph: (target) => readWorld({ wowRef: target.graph_endpoint, base: this.base,
        transport: this._transport, onLog: (message) => this._log(message) }),
      readHostState: () => this._readClientSceneHostState(),
      installClientSceneState: (input) => this._installClientSceneState(input),
      restoreLobbyState: (input) => this._restoreClientLobbyState(input),
      endpointDebug,
      defaultEquippedItems,
      presence: {
        departPresence: (input) => this.departPresence(input),
        stopHeartbeat: () => this.stopPresenceHeartbeat(),
        clearRegistration: () => this.clearPresenceRegistration(),
        registerPresence: (input) => this.registerPresence(input),
      },
      log: (message) => this._log(message),
      commitVisualTransition: () => this.commitVisualTransition(),
      runtimeStreams: {
        closeRuntimeStream: () => this.closeRuntimeStream(),
        connectRuntimeStream: (endpointKey) => this.connectRuntimeStream(endpointKey),
      },
      peers: {
        snapshot: () => this.peerPresenceSnapshot(),
        clear: () => this.clearPeerPresence(),
        restore: (snapshot) => this.restorePeerPresence(snapshot),
        broadcastPlayerPose: (input) => this.broadcastPlayerPose(input),
      },
      prefetch: {
        reset: (input) => this._fabricPrefetchController.reset(input),
      },
      updatePortalStatus: () => this._updatePortalStatus(),
      emitState: () => this._emit(),
      dispatchCrossing: (detail) => this.dispatchEvent(new CustomEvent("crossing", { detail })),
    });
  }

  _observeRuntimeState(message) {
        const debug = message && message.state && message.state.debug;
        this._runtimeStateTickCount = (this._runtimeStateTickCount || 0) + 1;
        const now = Date.now();
        if (now - (this._runtimeStateLogAtMs || 0) < RUNTIME_STATE_LOG_INTERVAL_MS) return;
        const ticks = this._runtimeStateTickCount - (this._runtimeStateLoggedTicks || 0);
        this._runtimeStateLogAtMs = now;
        this._runtimeStateLoggedTicks = this._runtimeStateTickCount;
        this._log(
          `runtime-state tick rev=${debug && debug.state_revision} input=${debug && debug.last_input_source}` +
            ` (+${ticks} ticks since last line; ${this._runtimeStateTickCount} total)`,
        );
  }

  _readClientSceneHostState() {
    return {
      clientMode: this.clientMode,
      activeEndpointKey: this.activeEndpointKey,
      previewEndpointKey: this.previewEndpointKey,
      endpoint: this.endpoint,
      previewEndpoint: this.previewEndpoint,
      base: this.base,
      portalId: this._portalId,
      world: this.world,
      controls: this.state.controls,
      preview: this.state.preview,
      portalPreviews: this.state.portal_previews,
      phase: this.state.phase,
      arrivalCount: this.state.arrival_count,
      movementBounds: this._movementBounds,
      wowLocalWalk: this._wowLocalWalk,
      wowResolved: this._wowResolved,
      wowSceneSource: this._wowSceneSource,
      boundaryOk: this._boundaryOk,
      boundaryProblems: this._boundaryProblems,
      avatar: this.state.avatar,
      equipmentStatus: this.state.equipment_status,
    };
  }

  _installClientSceneState({ origin, target, contract, resolved, bounds, spawn, avatar }) {
      this._airportWalkableSurface = createAirportWalkableSurfaceContract(resolved.graph);
      if (!this._airportWalkableSurface.ok) {
        throw new Error(`airport walkable-surface contract invalid: ${this._airportWalkableSurface.reason}`);
      }
      const entryGround = this._resolveAvatarGround(spawn[0], spawn[2]);
      if (!entryGround.ok) throw new Error(`airport entry ground resolution failed: ${entryGround.reason}`);
      spawn[1] = entryGround.surface_y_m;
      const sourcePortal = (origin.world?.portals || []).find(
        (portal) => fabricPortalKey(portal) === target.portal_id,
      ) || origin.world?.portal || null;
      const reciprocalResult = automaticReciprocalPortal({
        sourcePortal,
        destinationSpatialId: contract.spatial_id,
        originWorld: origin.world,
        destinationPortals: resolved.graph?.portals,
      });
      const reciprocalPortal = reciprocalResult.portal || null;
      this._wowResolved = resolved;
      this._wowSceneSource = {
        ok: true,
        via: "client_scene_load",
        resolved_from: target.graph_endpoint,
        graph_url: resolved.graph_url,
        spatialID: resolved.spatialID,
        node_count: resolved.node_count,
        resolved_at: new Date().toISOString(),
      };
      this.world = clientSceneWorld({ origin, contract, resolved, spawn, avatar, reciprocalPortal, role: this.role, provenance: PROVENANCE.LIVE });
      this._boundaryOk = true;
      this._boundaryProblems = [];
      this._wowLocalWalk = true;
      this._movementBounds =
        bounds && Number.isFinite(Number(bounds.minX)) && Number.isFinite(Number(bounds.maxX))
          ? {
              minX: Number(bounds.minX),
              maxX: Number(bounds.maxX),
              minZ: Number(bounds.minZ),
              maxZ: Number(bounds.maxZ),
            }
          : null;
      avatar.position = spawn;
      avatar.rotation_y = contract.entry_spawn.rotation_y;
      this.state.phase = HANDOFF_PHASES.IDLE;
      this.state.arrival_count = 0;
      this.state.preview = clientScenePreview({ origin, target, reciprocalPortal });
      this.state.portal_previews = null;
      this.state.controls = clientSceneControls({ origin, entryGround });
      avatar.locomotion = this.state.controls;
      this._jumpVelocity = 0;
      this._portalTraversalController.reset({ reason: "client_scene_load", startsEmbodied: false });
      return {
        activeEndpointKey: this.activeEndpointKey,
        endpoint: this.endpoint,
        world: this.world,
        reciprocal: reciprocalResult,
      };
  }

  _restoreClientLobbyState({ origin, avatar, equippedItems, arrival }) {
      this._airportWalkableSurface = null;
      this.activeEndpointKey = origin.activeEndpointKey;
      this.previewEndpointKey = origin.previewEndpointKey;
      this.endpoint = origin.endpoint;
      this.previewEndpoint = origin.previewEndpoint;
      this.base = origin.base;
      this._portalId = origin.portalId;
      this.world = origin.world;
      this._movementBounds = origin.movementBounds;
      this._wowLocalWalk = origin.wowLocalWalk;
      this._wowResolved = origin.wowResolved;
      this._wowSceneSource = origin.wowSceneSource;
      this._boundaryOk = origin.boundaryOk;
      this._boundaryProblems = origin.boundaryProblems;
      this.state.controls = JSON.parse(JSON.stringify(origin.controls || {}));
      this.state.phase = HANDOFF_PHASES.IDLE;
      this.state.arrival_count = origin.arrivalCount;
      this.state.preview = origin.preview;
      this.state.portal_previews = origin.portalPreviews;
      this.state.avatar = avatar;
      if (avatar) {
        const spawn = arrival && Array.isArray(arrival.position)
          ? arrival.position.slice()
          : this.world && this.world.avatar && Array.isArray(this.world.avatar.spawn_position)
            ? this.world.avatar.spawn_position.slice()
            : [0, 0, 0];
        avatar.position = spawn;
        avatar.rotation_y = arrival && Number.isFinite(Number(arrival.rotation_y))
          ? Number(arrival.rotation_y)
          : this.world && this.world.avatar ? this.world.avatar.rotation_y : 0;
        avatar.equippedItems = equippedItems;
        avatar.locomotion = this.state.controls;
      }
      this._jumpVelocity = 0;
      this._portalTraversalController.reset({ reason: "client_scene_return", startsEmbodied: true });
      return {
        activeEndpointKey: this.activeEndpointKey,
        endpoint: this.endpoint,
        world: this.world,
      };
  }

  _readTraversalHostSnapshot() {
    return {
      role: this.role,
      clientMode: this.clientMode,
      startsEmbodied: this._startsEmbodied,
      clientId: this._clientId,
      activeEndpointKey: this.activeEndpointKey,
      endpoint: this.endpoint,
      resolveEndpoint: (endpointKey) => ENDPOINTS[endpointKey],
      base: this.base,
      world: this.world,
      phase: this.state.phase,
      handoffId: this.state.handoff_id,
      arrivalCount: this.state.arrival_count,
      avatar: this.state.avatar,
      controls: this.state.controls,
      portalId: this._portalId,
      lastCameraTransform: this._lastCameraTransform,
      playerContextMarker: this._playerContextMarkerDebug(),
    };
  }

  _applyTraversalHostPatch(patch) {
      const has = (name) => Object.prototype.hasOwnProperty.call(patch, name);
      if (has("phase")) this.state.phase = patch.phase;
      if (has("handoffId")) this.state.handoff_id = patch.handoffId;
      if (has("arrivalCount")) this.state.arrival_count = patch.arrivalCount;
      if (has("controls")) Object.assign(this.state.controls, patch.controls || {});
      if (has("avatar")) {
        if (patch.avatarMode === "merge" && this.state.avatar && patch.avatar) {
          Object.assign(this.state.avatar, patch.avatar);
        } else {
          this.state.avatar = patch.avatar;
        }
      }
      if (has("equipmentStatus")) this.state.equipment_status = patch.equipmentStatus;
      if (has("lastHandoffDirection")) this.state.last_handoff_direction = patch.lastHandoffDirection;
      if (has("lastHandoffPayload")) this.state.last_handoff_payload = patch.lastHandoffPayload;
      if (has("lastPosePayload")) this.state.last_pose_payload = patch.lastPosePayload;
      if (has("playerHandoffProfile")) this.state.player_handoff_profile = patch.playerHandoffProfile;
  }

  async init() {
    const current = this._beginWorldNavigation();
    this._portalTraversalController.cancel();
    // learn the WoW endpoints from the fabric manifest's services[]
    // (spec integer routes) before touching any /wow resource; the root fabric
    // fetched here is cached and reused by _initWorldNavigator().
    const ep = await this._resolveWowEndpoints();
    if (!current()) return this;
    const wowWorld = await this._transport.getJson(ep.world.path);
    if (!current()) return this;
    // fetch the FULL portal set (spec integer routes
    // resolved from services[]; the /wow/world portal index gives the count).
    // The first resource's webofworlds_extension.portal_id gives back the
    // string frame id used by portal-frame descriptors + POST bodies.
    const wowPortals = await this._fetchWowPortals(ep, wowWorld);
    if (!current()) return this;
    const wowPortal = wowPortals[0] || null;
    let wowUser = null;
    try {
      // Spec integer route (/wow/user/1) resolved from services[].
      wowUser = await this._transport.getJson(ep.user.path);
      if (!current()) return this;
    } catch (e) {
        if (!current()) return this;
      /* ignore */
    }
    this._adoptPortalFrameId(wowPortal);

    this.world = worldFromLive(this.role, wowWorld, wowPortals, wowUser);
    this._lastPortalSignature = portalSignature(wowPortals);

    // verify the SIGNED OpenUserManifest identity fronted on
    // /wow/user (real Ed25519 / JCS-RFC8785 / did:key) and stash the HONEST result
    // for debugState().um_identity + the avatar identity badge. Best-effort +
    // non-fatal: a missing/failed signature degrades honestly, never blocks init.
    // Kept SEPARATE from the crossing-manifest signing (um_signing) + .msf spine.
    const identity = await verifyUmIdentity(wowUser);
    if (!current()) return this;
    this._umIdentity = identity;
    if (this.world && this.world.avatar) this.world.avatar.identity = this._umIdentity;

    // HARD GUARD: validate the four proof-boundary flags on the LIVE payload.
    const check = validateProofBoundary(this.world.claim_boundary);
    this._boundaryOk = check.ok;
    this._boundaryProblems = check.problems;

    if (this._startsEmbodied) this._spawnEmbodiedAvatarState();
    if (this.role === "player") await this._initPlayerPreview();
    if (!current()) return this;
    if (this.role === "player") await this._initWorldNavigator(current);
    if (!current()) return this;
    // re-source the ACTIVE world's SCENE from its WoW
    // Spatial Composition Graph (/wow/spatial/{id}) so the world renders from the
    // GRAPH — node counts / positions graph-sourced.
    // Best-effort + non-fatal (the destination world is re-sourced the same way
    // on promotion — see _promoteActiveEndpoint).
    if (this.role === "player") {
      const authoredEndpoint = authoredWowGraphEndpoint(wowWorld, this.base);
      await this._resolveWowSceneGraph({
        base: this.base,
        spatialId: wowWorldSpatialId(wowWorld),
        graphEndpoint: authoredEndpoint,
        resolvedFrom: authoredEndpoint
          ? "active backend /wow/world advertised authored /wow/graph (initial load)"
          : "active world /wow/world spatialID (initial load)",
      });
      if (!current()) return this;
      this._adoptLiveAirportScenePhysics(this._wowResolved);
    }
    this.state.arrival_count = this.world.initial_arrival_count ?? 0;
    this._updatePortalStatus();

    // the spawned player registers with its ACTIVE
    // server (explicit session action). Best-effort — a failure never blocks
    // init; the heartbeat upsert self-heals and the server TTL guards ghosts.
    if (this.clientMode === "player" && this.state.avatar) {
      await this._registerPresence("spawn");
      if (!current()) return this;
    }

    this._connectRuntimeStream();
    this._syncPresenceEventStreams();
    this._emit();
    // publish the spawn pose once so already-open same-location
    // observers snap to the player immediately (late observers also request
    // the current pose when they start listening).
    if (this.clientMode === "player") this._maybeBroadcastPlayerPose({ force: true });
    return this;
  }

  /**
   * Bind the accepted authored airport walkable-surface contract to a LIVE
   * backend world. This is the same resolver used by the fixture/local-walk
   * path; only its data source changes to the active backend's /wow/graph.
   */
  _adoptLiveAirportScenePhysics(resolved) {
    const isAirport =
      this.world?.location_id === "location-airport" &&
      resolved?.spatialID === "world-airport-terminal" &&
      resolved?.graph;
    if (!isAirport) {
      this._airportWalkableSurface = null;
      this._movementBounds = null;
      return null;
    }
    const contract = createAirportWalkableSurfaceContract(resolved.graph);
    if (!contract.ok) {
      throw new Error(`live airport walkable-surface contract invalid: ${contract.reason}`);
    }
    const walkable = contract.surfaces.filter((surface) => surface.classification === "walkable");
    this._airportWalkableSurface = contract;
    this._movementBounds = airportSurfaceBounds(walkable);

    // Initial airport boot may already have an embodied avatar. A crossing is
    // still visually staged here, so its destination avatar is grounded later
    // by _fabricDerivedExitPose without mutating the source-facing snapshot.
    if (this.state.phase === HANDOFF_PHASES.IDLE && this.state.avatar) {
      const position = clonePosition(this.state.avatar.position, [0, 0, -3]);
      const ground = this._resolveAvatarGround(position[0], position[2]);
      if (!ground.ok) throw new Error(`live airport spawn grounding failed: ${ground.reason}`);
      position[1] = ground.surface_y_m;
      this.state.avatar.position = position;
      this.world.avatar.spawn_position = position.slice();
      this._publishGroundSurface(ground);
    }
    return contract;
  }

  /**
   * override the just-computed spawn pose with a pose
   * restored from a MANUAL browser reload (client-side sessionStorage; see
   * app.js persistPlayerLocationState/readRestorablePlayerSession). `init()` and
   * `_initWorldNavigator()` have already run and seeded the avatar at the root
   * fabric's primary.camera spawn; this replaces that spawn with the player's
   * last walked position/facing on the SAME already-active fabric, so a refresh
   * resumes where the player stood instead of resetting to the room's spawn.
   *
   * The active fabric itself is chosen at construction from the URL `active`
   * param, so this method only touches POSE — never which world is loaded — and
   * makes NO server call. It is a no-op unless the player is embodied and idle
   * (never mid-crossing) and a finite position is supplied. Returns whether the
   * pose was applied so the caller can log/verify the round-trip.
   */
  _resolveAvatarGround(x, z) {
    return resolveAvatarGround(this._airportWalkableSurface, x, z);
  }

  _publishGroundSurface(query) {
    publishGroundSurface(this.state.controls, query);
  }

  applyRestoredPose(pose) {
    if (this.role !== "player" || !this._startsEmbodied || this.state.phase !== HANDOFF_PHASES.IDLE) return false;
    const restored = restoredAvatarPose(pose, this.world?.avatar, this._airportWalkableSurface);
    if (!restored) return false;
    const { position, yaw, ground } = restored;
    if (this.world && this.world.avatar) {
      this.world.avatar.spawn_position = position.slice();
      this.world.avatar.rotation_y = yaw;
    }
    if (this.state.avatar) {
      this.state.avatar.position = position.slice();
      this.state.avatar.rotation_y = yaw;
    }
    this._jumpVelocity = 0;
    if (this._airportWalkableSurface) {
      this._publishGroundSurface(ground);
      this.state.controls.grounded = true;
      this.state.controls.jump_height_m = 0;
      if (this.state.avatar) this.state.avatar.locomotion = { ...this.state.controls };
    }
    if (this._navigator) {
      this._navigator.restored_pose = {
        source: "manual_reload_session_restore",
        active_endpoint_key: this.activeEndpointKey,
        position: roundVec3(position, 4),
        rotation_y: roundNumber(yaw, 6),
      };
    }
    this._updatePortalStatus();
    this._emit();
    if (this.clientMode === "player") this._maybeBroadcastPlayerPose({ force: true });
    return true;
  }

  /**
   * Create the embodied local-avatar state + equipment status from
   * `this.world.avatar`. Factored out of initLive so the SAME creation is reused
   * verbatim by the WoW local-walk spawn — the avatar
   * model/shape (avatar_id/continuity_id/display_name/position/rotation_y/
   * locomotion/equippedItems/avatar_variant) and the default equipment are NOT
   * re-implemented anywhere. Requires `this.world.avatar` to be set.
   */
  _spawnEmbodiedAvatarState() {
    this.state.avatar = {
      avatar_id: this.world.avatar.avatar_id,
      continuity_id: this.world.avatar.continuity_id,
      display_name: this.world.avatar.display_name,
      position: this.world.avatar.spawn_position.slice(),
      rotation_y: this.world.avatar.rotation_y,
      locomotion: this.state.controls,
      // demo boots (?noequip=1) spawn the clean base avatar — no equipment.
      equippedItems: this._noDefaultEquipment ? [] : defaultEquippedItems(),
      avatar_variant: DEFAULT_AVATAR_VARIANT,
      // the person's preferred body height. null = no preference (the avatar
      // variant's authored scale is used). Set via setPreferredHeight(); a Universal
      // Manifest avatar facet would populate this.
      preferred_height_m: null,
      _provenance: PROVENANCE.LIVE,
    };
    this.state.equipment_status = {
      validation: validateEquippedItems(this.state.avatar.equippedItems),
      items: this.state.avatar.equippedItems.map((item) => ({
        itemId: item.itemId,
        mode: item.mode,
        attachmentPoint: item.attachmentPoint,
        assetUri: item.assetUri,
        fetch_ok: null,
        visible_fallback: false,
        message: "source item path prepared; fetch checked on destination",
      })),
    };
    return this.state.avatar;
  }

  /**
   * spawn the local VRM avatar into a WoW-composition-graph
   * world (the fixture `?wow=` walk), REUSING the exact live movement/avatar
   * machinery. This does NOT stand up a live backend: initWow() has already
   * resolved the graph document only. It sets a minimal `this.world` (the
   * equipment layer stores it but reads nothing from it; only location_id/world_id
   * are read by the pose-broadcast/persist helpers), spawns the avatar via the
   * SAME `_spawnEmbodiedAvatarState()` the live path uses, and installs the
   * per-world movement clamp MEASURED upstream from the WoW world extent (project
   * lesson: measure per world, never hardcode ±WORLD_LIMIT). `_wowLocalWalk`
   * neutralizes the live-only /movement POST + observer pose broadcast so the walk
   * is fully client-local. stepAvatar / the input loop / the camera rig run
   * UNCHANGED on the result.
   *
   * @param {object} opts { spawn:[x,y,z,yaw?], bounds:{minX,maxX,minZ,maxZ},
   *                        spatialID, title }
   */
  spawnWowLocalAvatar(opts = {}) {
    const spawn = localWalkState(opts, this._wowResolved || {}, { role: this.role, provenance: PROVENANCE.LIVE },
      surface => { this._airportWalkableSurface = surface; });
    this.world = spawn.world;
    this._boundaryOk = true;
    this._boundaryProblems = [];
    this._wowLocalWalk = true;
    this._movementBounds = spawn.bounds;
    this.state.phase = HANDOFF_PHASES.IDLE;
    this._spawnEmbodiedAvatarState();
    this._publishGroundSurface(spawn.ground);
    if (this._airportWalkableSurface) {
      this.state.controls.grounded = true;
      this.state.controls.jump_height_m = 0;
      this.state.avatar.locomotion = { ...this.state.controls };
    }
    this.state.arrival_count = 0;
    this._updatePortalStatus();
    this._emit();
    return this.state.avatar;
  }

  /** Resolve a fixture-backed client scene through the existing WoW graph
   * loader without changing the adapter's active world. */
  async resolveClientSceneLoad(target) {
    return this._clientSceneController.resolve(target);
  }

  /** What a portal shows of its destination: only what the destination's World resource declares. Does not change
   * the active world, reads no other node of the destination and creates no user there. */
  async resolvePortalDestinationContent(portalEntry) {
    const world = this.world;
    const navigation = this._worldNavigationOperation;
    const current = () => !this._disposed && this.world === world && this._worldNavigationOperation === navigation;
    const content = await resolveBoundedPreview(portalEntry, { fetch: (url, init) => fetch(url, init) });
    // A preview in the world's own frame also says where this portal arrives, before anyone crosses.
    if (current() && content.world_frame_known && portalEntry) portalEntry.target_frame = content.window_frame;
    return content;
  }

  /** The check before leaving, for the traversal controller (web/main-demo-portals.mjs, checkCrossing). */
  _checkCrossing(portal) {
    return checkCrossing(portal, {
      fetch: (url, init) => fetch(url, init),
      plain: this._crossingProfile === "plain",
      pageUrl: typeof window !== "undefined" && window.location ? window.location.href : null,
      // The /w/{key}/ pages live with the world servers, so a plain-navigation crossing goes to their origin.
      frontBase: typeof window !== "undefined" && window.location ? serverRootUrl(window.location) : null,
    });
  }

  /** Put the embodied player at node `nodeId` of the active world (a page opened at `#join=node.{n}`). */
  async applyJoinArrival(nodeId) {
    const world = this.world;
    const navigation = this._worldNavigationOperation;
    const current = () => !this._disposed && this.world === world && this._worldNavigationOperation === navigation;
    const address = this.endpoint && this.endpoint.backend_base_url ? `${this.endpoint.backend_base_url}/` : null;
    const arrival = address ? await arrivalAt(address, Number(nodeId), { fetch: (url, init) => fetch(url, init) }).catch(() => null) : null;
    if (!current()) return { arrived: false, reason: "navigation_retired" };
    if (!arrival) return { arrived: false, reason: `arrival node ${nodeId} not found` };
    const pose = poseOfMatrix(arrival.matrix);
    return { arrived: this.applyRestoredPose({ position: pose.position, rotation_y: pose.yaw }), node: arrival.node, ...pose };
  }

  /** True when the active world's portals differ from the portals shown (web/main-demo-portals.mjs, portalSignature). */
  async portalsChanged() {
    const world = this.world;
    const navigation = this._worldNavigationOperation;
    const current = () => !this._disposed && this.world === world && this._worldNavigationOperation === navigation;
    const ep = this._wowEndpoints;
    if (!ep || !ep.world || !this.world) return false;
    const wowWorld = await this._transport.getJson(ep.world.path);
    if (!current()) return false;
    const portals = await this._fetchWowPortals(ep, wowWorld);
    return current() && portalSignature(portals) !== this._lastPortalSignature;
  }

  /** Read the active world's portals again and show the difference, as a visit to the world would. */
  async refreshWorldPortals() {
    const operation = this._portalRefreshOperation = {};
    const navigation = this._worldNavigationOperation;
    const current = () => !this._disposed && this._portalRefreshOperation === operation && this._worldNavigationOperation === navigation;
    const { world, endpoint } = this;
    const destination = await readNavigationResources({ endpoint, role: this.role,
      transport: this._transport, isCurrent: () => current() && this.world === world });
    if (!current() || this.world !== world || !destination) return null;
    this.world.portal = destination.world.portal;
    this.world.portals = destination.world.portals;
    this._wowEndpoints = destination.resolution.endpoints;
    this._wowEndpointResolution = destination.resolution;
    this._rootFabricManifest = destination.rootFabric;
    this._rootFabricManifestUrl = destination.rootFabric ? `${this.base}/fabric.json` : null;
    this._portalTraversalController.forgetPortalSides();
    this._lastPortalSignature = destination.portalSignature;
    this._initPlayerPreview();
    this._updatePortalStatus();
    this._emit();
    return this.world.portals;
  }

  /**
   * enter a fixture-backed scene in this browser context.
   * No exit-intent/arrival backend handoff is emitted. The same avatar object,
   * identity, equipment, movement integrator, and browser context continue.
   */
  async enterClientSceneLoad({ target, contract, resolved, bounds, isCurrent } = {}) {
    const current = this._beginWorldNavigation(isCurrent);
    if (!isCurrent) this._portalTraversalController.cancel();
    return this._clientSceneController.enter({ target, contract, resolved, bounds, isCurrent: current });
  }

  /** Restore the saved live lobby after a client scene load. */
  async returnFromClientSceneLoad(options) {
    const current = this._beginWorldNavigation(options?.isCurrent);
    if (!options?.isCurrent) this._portalTraversalController.cancel();
    return this._clientSceneController.returnToLobby({ ...options, isCurrent: current });
  }

  _initPlayerPreview() {
    // a multi-portal world (the lobby) has no single
    // preview endpoint — every portal gets its own preview built against ITS
    // destination endpoint, keyed in state.portal_previews; state.preview
    // stays the PRIMARY portal's preview so every single-preview surface
    // (aperture ladder, HUD card, debug) keeps working unchanged.
    const portals =
      this.world && Array.isArray(this.world.portals) ? this.world.portals : [];
    this.state.portal_previews = {};
    for (const portal of portals) {
      const key = fabricPortalKey(portal);
      if (key) this.state.portal_previews[key] = this._buildEndpointPreview(portal);
    }
    const primaryKey = portals[0] ? fabricPortalKey(portals[0]) : null;
    this.state.preview = (primaryKey && this.state.portal_previews[primaryKey]) || null;
  }

  /** The record of what one portal previews. It reads nothing from the destination: the see-through view comes
   *  from the destination's own preview (resolvePortalDestinationContent). */
  _buildEndpointPreview(portal) {
    const key = endpointKeyForLocation(portal && portal.target_location_id);
    return endpointPreview(key ? ENDPOINTS[key] : {}, this.endpoint);
  }

  /**
   * open a WoW world by URL/id and resolve its
   * Spatial Composition Graph for the render seam. Fixtures-first: `wowRef` is
   * EITHER a URL/path to a dev-fixture bundle (the typed graph mocks we
   * develop against before the server serves /wow/spatial) OR a bare
   * spatialID that resolves against the canonical live endpoint
   * GET /wow/spatial/{id} (then a per-node /node/{nodeId} BFS walk — the spec's
   * own canonical node path). Returns a resolved graph { spatialID, root, nodes }
   * plus honest provenance. It does NOT render — app.js/mainWowRead feeds the
   * graph into buildWowScene (the additive seam), mirroring the ?fabric= path.
   */
  async initWow() {
    const operation = this._wowReadOperation = {};
    const { base, wowRef, world } = this;
    const resolved = await readWorld({ wowRef, base, transport: this._transport, onLog: (message) => this._log(message) });
    if (!this._disposed && this._wowReadOperation === operation && this.base === base && this.wowRef === wowRef && this.world === world) this._wowResolved = resolved;
    return resolved;
  }

  _readGraphDocument(graphUrl, doc) {
    return readGraph(graphUrl, doc, { transport: this._transport, onLog: (message) => this._log(message) });
  }

  _walkCanonicalGraph(graphUrl, rootNode) {
    return walkCanonicalGraph(graphUrl, rootNode, { transport: this._transport, onLog: (message) => this._log(message) });
  }

  async _resolveWowSceneGraph(o = {}) {
    const operation = this._wowSceneReadOperation = {};
    const { base, world, wowRef } = this;
    const result = await readSceneGraph({ ...o, base: o.base || base }, { transport: this._transport, onLog: (message) => this._log(message) });
    if (!this._disposed && this._wowSceneReadOperation === operation && this.base === base && this.world === world && this.wowRef === wowRef) {
      if (result.resolved) this._wowResolved = result.resolved;
      this._wowSceneSource = result.record;
    }
    return result.record;
  }

  wowResolved() {
    return this._wowResolved;
  }

  wowSceneSource() {
    return this._wowSceneSource;
  }

  async _ensureRootFabric() {
    const { base, world } = this;
    const rootUrl = `${base}/fabric.json`;
    if (this._rootFabricManifest && this._rootFabricManifestUrl === rootUrl) return this._rootFabricManifest;
    const operation = this._rootFabricReadOperation = {};
    const manifest = await readRootFabric(base, this._transport);
    if (manifest && !this._disposed && this._rootFabricReadOperation === operation && this.base === base && this.world === world) {
      this._rootFabricManifest = manifest;
      this._rootFabricManifestUrl = rootUrl;
    }
    return manifest;
  }

  async _resolveWowEndpoints() {
    const operation = this._wowEndpointReadOperation = {};
    const { base, world } = this;
    const manifest = await this._ensureRootFabric();
    const resolution = resolveWowEndpoints(manifest, base);
    if (!this._disposed && this._wowEndpointReadOperation === operation && this.base === base && this.world === world) {
      this._wowEndpoints = resolution.endpoints;
      this._wowEndpointResolution = resolution;
      this._log(`wow-endpoints: ${resolution.resolved_from_services ? "resolved from fabric services[]" : "using fallback constants"} ` +
        `world=${resolution.provenance.world.resolved_path} user=${resolution.provenance.user.resolved_path} ` +
        `portal=${resolution.provenance.portal.resolved_path} view=${resolution.provenance.view.resolved_path}`);
    }
    return resolution.endpoints;
  }

  _fetchWowPortals(ep, wowWorld) {
    return readPortals(this.base, wowWorld, { transport: this._transport, onLog: (message) => this._log(message) });
  }

  /**
   * adopt the STRING frame id from a fetched WoW Portal resource's
   * webofworlds_extension.portal_id. The client fetches the portal by its
   * INTEGER spec route (/wow/portal/1) but keeps the string id for the portal
   * frame descriptors and the exit-intent POST body (which the server resolves
   * by string portal_id). The endpoint constant stays the fallback.
   */
  _adoptPortalFrameId(wowPortal) {
    const ext = wowPortal && wowPortal.webofworlds_extension ? wowPortal.webofworlds_extension : null;
    const frameId = ext && typeof ext.portal_id === "string" ? ext.portal_id : null;
    if (frameId) this._portalId = frameId;
  }

  /**
   * fetch /wow/view/1 (the PlayerView camera as a WoW View,
   * resolved from services[]) and compare the server-projected camera position
   * to the local PlayerView camera. Proves the server View tracks the live
   * camera. Read-only; never touches crossing state. Populates this._viewMatch
   * and returns it (or null if no local camera is available yet).
   */
  async verifyViewMatchesCamera() {
    const local = this._lastCameraTransform;
    const localPos = local && Array.isArray(local.position) ? local.position : null;
    if (!localPos) return null;
    const ep = this._wowEndpoints && this._wowEndpoints.view
      ? this._wowEndpoints.view
      : { path: `${this.base}/wow/view/1`, id: 1 };
    let view;
    try {
      view = await this._transport.getJson(ep.path);
    } catch (e) {
      this._viewMatch = { ok: false, reason: `view fetch failed: ${e.message}`, endpoint: this._transport.displayPath(ep.path) };
      return this._viewMatch;
    }
    const cam = view && view.webofworlds_extension && view.webofworlds_extension.local_camera
      ? view.webofworlds_extension.local_camera.position
      : null;
    if (!Array.isArray(cam)) {
      this._viewMatch = { ok: false, reason: "view response has no local_camera.position", endpoint: this._transport.displayPath(ep.path) };
      return this._viewMatch;
    }
    const dx = (Number(cam[0]) || 0) - (Number(localPos[0]) || 0);
    const dy = (Number(cam[1]) || 0) - (Number(localPos[1]) || 0);
    const dz = (Number(cam[2]) || 0) - (Number(localPos[2]) || 0);
    const delta = Math.hypot(dx, dy, dz);
    const matches = delta < 0.05;
    this._viewMatch = {
      ok: matches,
      endpoint: this._transport.displayPath(ep.path),
      view_id: view && view.id != null ? view.id : ep.id,
      delta_m: roundNumber(delta, 4),
      threshold_m: 0.05,
      server_camera_position: roundVec3(cam, 4),
      local_camera_position: roundVec3(localPos, 4),
      // The server /wow/view/1 projects its OWN avatar pose (independently
      // integrated from /movement) through the PlayerView rig; the client
      // camera uses the client avatar pose + a fixed heading. They agree at
      // spawn (before divergent integration) and drift during free movement —
      // an honest projection comparison, not a conformance claim.
      pose_note:
        "server View projects the server-side avatar pose (independent /movement integration); " +
        "matches the client camera at synced poses, expected drift during free local movement",
      summary: matches
        ? `server View matches local camera (Δ${roundNumber(delta, 4)} m < 0.05 m)`
        : `server View Δ${roundNumber(delta, 4)} m vs local camera (server pose independently integrated; agrees at spawn)`,
    };
    return this._viewMatch;
  }

  /**
   * World Navigator: single-context load + compose.
   * 1. Fetch the ACTIVE world's fabric manifest (plain-JSON, unsigned, labeled).
   * 2. Spawn the avatar at the fabric's own `primary.camera` pose.
   * 3. Find the portal attachment node (Type.bSubtype: 255) and fetch the CHILD
   *    fabric its Resource.sReference points at (read-only GET; no target
   *    mutation before crossing).
   * 4. Upgrade the in-memory player_context_marker into the navigator session
   *    marker: both fabrics recorded in ONE context.
   * All failures are non-fatal: the legacy /wow-projected world remains the
   * fallback and is recorded as such.
   */
  async _initWorldNavigator(isCurrent = () => true) {
    const { base, world } = this;
    const operation = this._navigatorReadOperation = {};
    const rootFabric = await this._ensureRootFabric();
    if (this._disposed || !isCurrent() || this._navigatorReadOperation !== operation || this.base !== base || this.world !== world) return null;
    this._adoptWorldNavigator(projectWorldNavigator({ base, rootFabric, world,
      marker: this._playerContextMarker, promotions: this._navigatorPromotions }));
    return this._navigator;
  }

  _adoptWorldNavigator(navigator) {
    this._navigator = navigator;
    const spawn = this._rootFabricManifest ? navigatorSpawn(this._rootFabricManifest) : navigator.spawn;
    if (spawn.applied) {
      this.world.avatar.spawn_position = spawn.position.slice();
      this.world.avatar.rotation_y = spawn.rotation_y;
      if (this.state.avatar && this._startsEmbodied && this.state.phase === HANDOFF_PHASES.IDLE) {
        this.state.avatar.position = spawn.position.slice();
        this.state.avatar.rotation_y = spawn.rotation_y;
      }
    }
    if (navigator.status === "root_fabric_unavailable") {
      this._rootFabricManifest = null;
      this._rootFabricManifestUrl = null;
      return;
    }
    if (navigator.portal_attachment) this._childFabricManifest = null;
    this._updateMarkerFromNavigator();
  }

  _updateMarkerFromNavigator() {
    updateNavigatorMarker(this._navigator, this._playerContextMarker);
  }

  /** Child fabric manifest for the renderer (app.js) — read-only data. */
  childFabricManifest() {
    return this._childFabricManifest || null;
  }

  /**
   * Renderer callback (app.js): records whether the child fabric is actually
   * being rendered through the aperture. Only a CONFIRMED render upgrades the
   * preview source_type away from the labeled placeholder — the claim
   * stays honest on canvas2d degrades.
   */
  setChildFabricRenderState(info) {
    if (!this._navigator) return;
    this._navigator.child_render = { ...(info || {}), updated_at: new Date().toISOString() };
    const preview = this.state.preview;
    if (!preview) return;
    if (info && info.active === true) {
      preview.state = "child_fabric_attached";
      preview.source_type = "child_fabric_live_render_texture";
      preview.preview_source_type = preview.source_type;
      preview.fallback_reason = null;
      preview.preview_fallback_reason = null;
      preview.child_fabric_url = this._navigator.child_fabric ? this._navigator.child_fabric.url : null;
      preview.child_fabric_container = this._navigator.child_fabric
        ? this._navigator.child_fabric.container
        : null;
      preview.projection_frame_source = info.camera_source || preview.projection_frame_source;
      preview.captured_at = new Date().toISOString();
    } else if (info && info.reason && this._navigator.child_fabric && this._navigator.child_fabric.status === "loaded") {
      preview.fallback_reason = `child fabric loaded in-context but not rendered: ${info.reason}`;
      preview.preview_fallback_reason = preview.fallback_reason;
    }
  }

  /** Renderer heartbeat: one call per aperture render-to-texture frame. */
  markChildFabricPreviewFrame() {
    if (!this._navigator || !this._navigator.child_render) return;
    const render = this._navigator.child_render;
    render.frame_count = (Number(render.frame_count) || 0) + 1;
    render.last_frame_at = new Date().toISOString();
    if (this.state.preview && this.state.preview.source_type === "child_fabric_live_render_texture") {
      this.state.preview.captured_at = render.last_frame_at;
    }
  }

  _navigatorDebug() {
    if (!this._navigator) return null;
    return {
      ...this._navigator,
      root_fabric: this._navigator.root_fabric ? { ...this._navigator.root_fabric } : null,
      child_fabric: this._navigator.child_fabric ? { ...this._navigator.child_fabric } : null,
      portal_attachment: this._navigator.portal_attachment ? { ...this._navigator.portal_attachment } : null,
      child_render: this._navigator.child_render ? { ...this._navigator.child_render } : null,
      fabrics_loaded: (this._navigator.fabrics_loaded || []).slice(),
    };
  }

  _applyPreviewReadOnlyDebug(debugState, opts = {}) {
    const preview = this.state.preview;
    if (!preview || !debugState) return;
    const arrivalCount = Number(debugState && debugState.session && debugState.session.arrival_count) || 0;
    const revision = Number(debugState && debugState.debug && debugState.debug.state_revision) || 0;
    const hasHandoffContext = !!(debugState && debugState.avatar && debugState.avatar.handoff_context);
    if (opts.initialize || preview.target_arrival_count_before_preview === null) {
      preview.target_arrival_count_before_preview = arrivalCount;
      preview.target_state_revision_before_preview = revision;
      preview.target_handoff_context_before_preview = hasHandoffContext;
    }
    const beforeArrival = Number(preview.target_arrival_count_before_preview) || 0;
    const beforeRevision = Number(preview.target_state_revision_before_preview) || 0;
    preview.target_arrival_count_current = arrivalCount;
    preview.target_state_revision_current = revision;
    preview.target_handoff_context_current = hasHandoffContext;
    preview.target_debug_last_input_source = debugState && debugState.debug ? debugState.debug.last_input_source || null : null;
    preview.target_avatar_presence_created =
      arrivalCount > beforeArrival ||
      (preview.target_handoff_context_before_preview !== true && hasHandoffContext === true);
    preview.target_mutation_count_during_preview = Math.max(0, revision - beforeRevision);
    preview.readonly = true;
    preview.preview_readonly = true;
  }

  async refreshPreviewReadOnlyState() {
    const world = this.world;
    const navigation = this._worldNavigationOperation;
    const current = () => !this._disposed && this.world === world && this._worldNavigationOperation === navigation;
    if (!this.previewEndpoint || !this.state.preview) return this._previewDebug();
    try {
      const debugState = await this._transport.getJson(`${this.previewEndpoint.proxy_base}/debug/state`);
      if (!current()) return;
      this._applyPreviewReadOnlyDebug(debugState);
      this.state.preview.captured_at = new Date().toISOString();
      this.state.preview.freshness_ms = 0;
      this.state.preview.preview_freshness_ms = 0;
    } catch (err) {
      if (!current()) return;
      this.state.preview.state = "error";
      this.state.preview.fallback_reason = `target preview readonly refresh failed: ${err.message}`;
      this.state.preview.preview_fallback_reason = this.state.preview.fallback_reason;
    }
    return this._previewDebug();
  }

  updatePreviewProjection(cameraTransform) {
    if (cameraTransform) this._lastCameraTransform = cameraTransform;
    if (!this.state.preview || !this.world || !this.world.portal) return this._previewDebug();
    const projection = mapCameraBetweenPortalFrames({
      sourceFrame: this.world.portal.frame,
      targetFrame: this.world.portal.target_frame,
      cameraTransform,
    });
    this.state.preview.source_camera_relative_to_portal = projection.source_camera_relative_to_portal;
    this.state.preview.target_preview_camera_transform = projection.target_preview_camera_transform;
    this.state.preview.preview_projection_transform = projection.preview_projection_transform;
    this.state.preview.projection_frame_source = "source_portal_frame+target_portal_frame";
    return this._previewDebug();
  }

  /* ---------------- step 5: runtime avatar controls -------
   * Switch the player's avatar VRM and equip new
   * items AT RUNTIME. Both mutate the ONE avatar's state (a switch REPLACES
   * the variant key; an equip APPENDS to equippedItems — never a second
   * avatar), broadcast a forced pose so observers mirror immediately, and ride
   * the existing crossing packet (avatar_context) so they survive crossings. */

  /** Switch the player's avatar to a different VRM variant at runtime. */
  setAvatarVariant(variantKey) {
    if (this.clientMode !== "player") return { ok: false, error: "player-only control" };
    if (!this.state.avatar) return { ok: false, error: "no embodied avatar (crossing in flight?)" };
    if (!AVATAR_VARIANTS[variantKey]) {
      return {
        ok: false,
        error: `unknown avatar variant '${variantKey}' (have: ${Object.keys(AVATAR_VARIANTS).join(", ")})`,
      };
    }
    this.state.avatar.avatar_variant = variantKey;
    this._log(`avatar switch requested -> '${variantKey}' (${AVATAR_VARIANTS[variantKey].label})`);
    this._maybeBroadcastPlayerPose({ force: true });
    this._emit();
    return { ok: true, variant: variantKey, label: AVATAR_VARIANTS[variantKey].label };
  }

  /**
   * set the player's PREFERRED BODY HEIGHT in metres (null clears it).
   *
   * This is the Universal-Manifest-shaped setting to prove: a person's
   * preferred height is a property of the PERSON, not of the avatar asset, so it lives on
   * the avatar STATE next to avatar_variant and rides the same broadcast + crossing packet.
   * It therefore survives a portal crossing and is mirrored to observers/remote peers for
   * free. The rendering half resolves it against whichever rig is worn
   * (AvatarEquipmentLayer#applyPreferredHeightM).
   *
   * The UM read half is deliberately NOT wired yet — a UM avatar facet
   * would call exactly this, and nothing else would change.
   */
  setPreferredHeight(heightM) {
    if (this.clientMode !== "player") return { ok: false, error: "player-only control" };
    if (!this.state.avatar) return { ok: false, error: "no embodied avatar (crossing in flight?)" };
    if (heightM === null || heightM === undefined || heightM === "") {
      this.state.avatar.preferred_height_m = null;
      this._log("preferred avatar height cleared (falling back to the variant's authored scale)");
    } else {
      const h = Number(heightM);
      if (!Number.isFinite(h) || h < 0.6 || h > 2.6) {
        return { ok: false, error: `preferred height must be a number in 0.6-2.6 m (got '${heightM}')` };
      }
      this.state.avatar.preferred_height_m = h;
      this._log(`preferred avatar height set -> ${h} m (applied to whichever rig is worn)`);
    }
    this._maybeBroadcastPlayerPose({ force: true });
    this._emit();
    return { ok: true, preferred_height_m: this.state.avatar.preferred_height_m };
  }

  /**
   * Toggle between two demo variants (upgraded <-> dwarf).
   *
   * The dwarf is CC0 and self-authored, and is the better demo pick:
   * it is the uniquely-SHAPED rig (short + wide), so the swap visibly proves the
   * height/proportion tracking that a same-shaped swap does not.
   */
  toggleAvatarVariant() {
    const current =
      (this.state.avatar && this.state.avatar.avatar_variant) || DEFAULT_AVATAR_VARIANT;
    return this.setAvatarVariant(current === "upgraded" ? "dwarf" : "upgraded");
  }

  /**
   * Equip an additional held/worn catalog item at runtime (attaches to the
   * correct VRM humanoid bone via the equipment layer). With no itemId, the
   * first not-yet-equipped catalog item is chosen (deterministic for drivers).
   */
  async equipCatalogItem(itemId) {
    if (this.clientMode !== "player") return { ok: false, error: "player-only control" };
    if (!this.state.avatar) return { ok: false, error: "no embodied avatar (crossing in flight?)" };
    const catalog = equipmentCatalog();
    const current = Array.isArray(this.state.avatar.equippedItems)
      ? this.state.avatar.equippedItems
      : [];
    const item = itemId
      ? catalog.find((entry) => entry.itemId === itemId)
      : catalog.find((entry) => !current.some((worn) => worn.itemId === entry.itemId));
    if (!item) {
      return {
        ok: false,
        error: itemId
          ? `unknown catalog item '${itemId}' (have: ${catalog.map((entry) => entry.itemId).join(", ")})`
          : "all catalog items already equipped",
      };
    }
    if (current.some((worn) => worn.itemId === item.itemId)) {
      return { ok: false, error: `'${item.itemId}' is already equipped` };
    }
    const next = current.concat([item]);
    const validation = validateEquippedItems(next);
    if (!validation.ok) {
      return { ok: false, error: `equip rejected by schema: ${validation.errors.join("; ")}` };
    }
    this.state.avatar.equippedItems = next;
    this.state.equipment_status = await resolveEquipmentItems(next);
    this._log(`equipped '${item.itemId}' (${item.mode} @ ${item.attachmentPoint}) at runtime`);
    this._maybeBroadcastPlayerPose({ force: true });
    this._emit();
    return {
      ok: true,
      itemId: item.itemId,
      mode: item.mode,
      attachmentPoint: item.attachmentPoint,
      equipped_count: next.length,
    };
  }

  /** The catalog of runtime-equippable items (for the UI/driver). */
  equippableCatalog() {
    const current =
      this.state.avatar && Array.isArray(this.state.avatar.equippedItems)
        ? this.state.avatar.equippedItems.map((item) => item.itemId)
        : [];
    return equipmentCatalog().map((item) => ({
      itemId: item.itemId,
      mode: item.mode,
      attachmentPoint: item.attachmentPoint,
      label: item.label,
      equipped: current.includes(item.itemId),
    }));
  }

  claimBoundary() {
    return this.world ? this.world.claim_boundary : null;
  }
  boundaryStatus() {
    return { ok: this._boundaryOk, problems: this._boundaryProblems };
  }

  /* ---------------- portal-render proof -------------------
   * Demo-extension transport for the RELOADABLE hosted point ("UM attach-point"
   * — the demo's interpretation of the documented fallback: the Universal
   * Manifest attaches to a point HOSTED by the server; clients RE-READ it, the
   * server never streams it). /demo/* is a labeled demo extension, NOT part of
   * the OpenSpatialWorld API surface, so these use a PLAIN fetch and are
   * deliberately NOT routed through the WoW API activity log (the log is a
   * capped 24-row WoW-surface record the e2e asserts against; periodic demo
   * reload traffic must not flush it).
   */
  demoProxyBase(endpointKey) {
    const endpoint = ENDPOINTS[endpointKey];
    return endpoint ? endpoint.proxy_base : this.base;
  }
  async demoReadAttachPoint(endpointKey) {
    const res = await this._transport.rawFetch(`${this.demoProxyBase(endpointKey)}/demo/um/attach-point`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GET /demo/um/attach-point (${endpointKey}) -> ${res.status}`);
    const attachPoint = await res.json();
    this.dispatchEvent(new CustomEvent(HOSTED_ATTACH_POINT_EVENT, {
      detail: { endpoint_key: endpointKey, attach_point: attachPoint },
    }));
    return attachPoint;
  }
  async demoReadPortalView(endpointKey, resolution) {
    const res = await this._transport.rawFetch(
      `${this.demoProxyBase(endpointKey)}/demo/portal-view?resolution=${encodeURIComponent(String(resolution || "snapshot3d"))}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`GET /demo/portal-view (${endpointKey}) -> ${res.status}`);
    return res.json();
  }
  async demoMoveSceneObject(endpointKey, objectId, position) {
    const res = await this._transport.rawFetch(`${this.demoProxyBase(endpointKey)}/demo/scene-objects/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ object_id: objectId, position }),
    });
    if (!res.ok) throw new Error(`POST /demo/scene-objects/move (${endpointKey}) -> ${res.status}`);
    return res.json();
  }
  async demoMovePortal(endpointKey, position) {
    const res = await this._transport.rawFetch(`${this.demoProxyBase(endpointKey)}/demo/portal/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ position }),
    });
    if (!res.ok) throw new Error(`POST /demo/portal/move (${endpointKey}) -> ${res.status}`);
    return res.json();
  }
  /* read/set the OPTIONAL server republish cadence (server-
   * side ambient drift of the hosted objects). Same labeled /demo/* transport
   * as the helpers above — a PLAIN fetch, deliberately NOT routed through the
   * capped WoW API activity log the e2e asserts on. Default cadence 0 = OFF. */
  async demoReadRepublishRate(endpointKey) {
    const res = await this._transport.rawFetch(`${this.demoProxyBase(endpointKey)}/demo/republish-rate`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GET /demo/republish-rate (${endpointKey}) -> ${res.status}`);
    return res.json();
  }
  async demoSetRepublishRate(endpointKey, republishRateMs) {
    const res = await this._transport.rawFetch(`${this.demoProxyBase(endpointKey)}/demo/republish-rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ republish_rate_ms: republishRateMs }),
    });
    if (!res.ok) throw new Error(`POST /demo/republish-rate (${endpointKey}) -> ${res.status}`);
    return res.json();
  }

  /**
   * adopt the ACTIVE world's portal pose from a reloaded hosted point.
   * Rebuilds this.world.portal.trigger + .frame through the SAME
   * portalFrameForLocation math worldFromLive() used at boot, so the standing
   * oval visual, the crossing plane math (_updatePortalStatus reads
   * world.portal.frame live each tick), and the frame mapping all follow the
   * hosted (possibly dragged) portal position together.
   */
  applyHostedPortalPose(triggerPosition) {
    const result = adoptHostedPortalPose(this.world, triggerPosition);
    if (result.changed) this._updatePortalStatus();
    if (result.changed) this._emit();
    return result;
  }

  /**
   * adopt the DESTINATION world's portal pose (from reloading the
   * destination's hosted point) into world.portal.target_frame, so a crossing
   * exits at the destination portal's CURRENT (possibly dragged) position.
   */
  applyHostedTargetPortalPose(triggerPosition) {
    const result = adoptHostedTargetPortalPose(this.world, triggerPosition);
    if (result.changed) this._updatePortalStatus();
    return result;
  }

  /**
   * keyed generalization of applyHostedTargetPortalPose.
   * Every portal entry's target_frame is BUILT as a placeholder anchored on
   * the source portal's own trigger (buildPortalFrameSet has no destination
   * data yet). The A<->B rooms coincidentally place their portals at the same
   * coordinates, which masked the placeholder; the lobby portals do not
   * (lobby-portal-a sits 4.8 m from location-a's real portal) — the
   * aperture-misalignment screenshot. The /fabric/region payload carries the
   * destination server's OWN portal pose; adopt it into THIS machine's portal
   * entry so the aperture glue plane, the through-ring destination ring, the
   * crossing exit, and the post-arrival world all anchor on the destination's
   * real portal. Same rebuild recipe as the hosted-point adoption.
   */
  _adoptDestinationPortalPoseForMachine(machine, portalPose) {
    const result = adoptDestinationPortalPose(this.world, machine, portalPose, (message) => this._log(message));
    if (result.changed) this._updatePortalStatus();
    return result;
  }

  /** Operator/debug activation; the normal path starts when the avatar enters the trigger. */
  activatePortal() {
    if (!this._portalTraversalController.activate()) return;
    this._updatePortalStatus();
    this._emit();
  }

  /**
   * read the one existing movement owner's run calibration. Before the
   * runtime palette mounts, the source formula remains authoritative; after it
   * mounts, translation is the coherent product of the two independent values.
   */
  runCalibrationSnapshot() {
    return runCalibrationSnapshot(this._runCalibration);
  }

  /**
   * The movement tuning of the avatar the runtime animates (avatar/actionforge-avatar.mjs). With it, stepAvatar moves
   * the avatar with the runtime's Locomotion: acceleration, a bounded turn along which it walks, and the three-part
   * jump. null returns to the lab's own movement (an avatar outside the runtime).
   */
  setAvatarLocomotionTuning(tuning) {
    this._avatarLocomotionTuning = tuning || null;
    this._avatarLocomotion = null;
  }

  /**
   * While the lab moves the avatar itself (a portal walk-through, a handoff), the runtime's motion record says what the
   * lab does: on the ground, at the speed of the last planar step. The runtime's Locomotion starts again at the arrival.
   */
  _publishRuntimeGroundMotion(dt) {
    if (publishRuntimeGroundMotion(this.state.avatar, this.state.controls, this._avatarLocomotionTuning, dt)) {
      this._avatarLocomotion = null;
    }
  }

  /** The runtime's Locomotion for this avatar, made at the avatar's place; it follows any jump in place (a crossing). */
  _runtimeLocomotion(avatar, groundY) {
    if (!this._avatarLocomotionTuning) return null;
    this._avatarLocomotion = runtimeLocomotion(this._avatarLocomotion, this._avatarLocomotionTuning, avatar, groundY);
    return this._avatarLocomotion;
  }

  /** Install both run-cycle values atomically; no server/URL/storage default is written. */
  setRunCalibration(input) {
    this._runCalibration = runCalibration(input);
    const snapshot = applyRunCalibration(this.state.controls, this.state.avatar, this._runCalibration);
    this._emit();
    return snapshot;
  }

  stepAvatar(input, deltaSeconds) {
    if (!this.state.avatar) return this.state.controls;
    const dt = clamp(Number(deltaSeconds) || 0, 0, 0.05);
    if (dt <= 0) return this.state.controls;
    if (this._portalTraversalController.inTransition()) {
      this._stepPortalTransition(dt);
      this._publishRuntimeGroundMotion(dt);
      return this.state.controls;
    }
    if (![HANDOFF_PHASES.IDLE, HANDOFF_PHASES.ARRIVED, HANDOFF_PHASES.PORTAL_ACTIVE].includes(this.state.phase)) {
      this._publishRuntimeGroundMotion(0);
      return this.state.controls;
    }
    const frame = movementFrame(this.state.avatar, this.state.controls, input, dt);
    frame.currentGround = this._resolveAvatarGround(frame.p[0], frame.p[2]);
    if (!frame.currentGround.ok) {
      this._publishGroundSurface(frame.currentGround);
      return this.state.controls;
    }
    const loco = this._runtimeLocomotion(frame.avatar, frame.currentGround.surface_y_m);
    if (loco) return this._stepRuntimeLocomotion(dt, input || {}, loco, frame);
    const result = stepLegacyMovement(frame, { bounds: this._movementBounds,
      velocity: this._jumpVelocity, calibration: this.runCalibrationSnapshot() }, (x, z) => this._resolveAvatarGround(x, z));
    return this._finishMovementStep(dt, result);
  }

  /**
   * One movement step with the avatar runtime's Locomotion: it accelerates, turns at a bounded rate and walks along its
   * facing, and runs the jump (crouch, push, air, land). The lab keeps the world: the bounds, the classified walkable
   * ground (a step off it is refused) and the ground's height under the feet; the jump's height rides on top of it.
   */
  _stepRuntimeLocomotion(dt, controls, loco, ctx) {
    const frame = { ...ctx, dt, controls, stateControls: this.state.controls };
    const result = stepRuntimeMovement(frame, { bounds: this._movementBounds,
      tuning: this._avatarLocomotionTuning }, loco, (x, z) => this._resolveAvatarGround(x, z));
    return this._finishMovementStep(dt, result);
  }

  shouldAutoHandoff() {
    return this._portalTraversalController.shouldAutoHandoff();
  }

  markAutoHandoffObserved() {
    this._portalTraversalController.markAutoHandoffObserved();
  }

  /** Narrow public facade for movement-controller pose edges. */
  broadcastPlayerPose({ force = false } = {}) {
    return this._maybeBroadcastPlayerPose({ force: force === true });
  }

  /**
   * Debug/operator entry point. The real commit is made by the traversal controller
   * when the avatar crosses the portal plane.
   */
  async triggerHandoff() {
    this._portalTraversalController.triggerHandoff();
  }

  // RP1 fail-closed gate wiring (the smallest live-integration seam).
  // The gate runs at the TOP of the controller commit, i.e. before the exit-intent
  // POST, before signing, before any promotion — so a fail-closed deny means the child
  // scope NEVER opens. Fail-closed rules per integrations/rp1-spatial-fabric.md §Guardrails.

  /** Arm/disarm the visible fail-closed demo mode ("off" | "stale-attachment" | "revoked-session"). */
  setRp1FailClosedDemoMode(mode) {
    if (!RP1_FAIL_CLOSED_MODES.includes(mode)) {
      // Unknown mode: refuse the call (never guess a posture), keep the current mode.
      return {
        ok: false,
        error: `unknown RP1 fail-closed demo mode ${JSON.stringify(mode)} (valid: ${RP1_FAIL_CLOSED_MODES.join(", ")})`,
        demo_mode: this._rp1FailClosed.demo_mode,
      };
    }
    this._rp1FailClosed.demo_mode = mode;
    this._log(
      `RP1 fail-closed demo mode -> ${mode}` +
        (mode === "off"
          ? " (happy path: gate allows the local one-context crossing)"
          : " (armed: the next crossing attempt will be DENIED fail-closed with a rejected receipt)")
    );
    this._emit();
    return { ok: true, demo_mode: mode };
  }

  /**
   * Consult the fail-closed gate for the imminent portal traversal. Builds the RP1 section
   * from the LIVE navigator state via the model, with the demo mode driving the
   * input hooks (attachmentStatus / sessionContextStatus) — consumed, never
   * re-derived. Returns the receipt (also stored for debugState()/the UI).
   * Windows with no World Navigator scope (observer mirrors / legacy source-role flow)
   * have no RP1 parent->child attachment to authorize: the gate is not-applicable there —
   * UNLESS a fail-closed demo mode is explicitly armed, which still denies (never open).
   */
  _rp1GateCheck() {
    const mode = RP1_FAIL_CLOSED_MODES.includes(this._rp1FailClosed.demo_mode)
      ? this._rp1FailClosed.demo_mode
      : "off";
    let receipt;
    try {
      const nav = this._navigatorDebug();
      // A world with no fabric attachment (one with only placed portals) has no parent->child scope to authorize.
      const section = nav && (nav.portal_attachment || mode !== "off") ? buildRp1Section(nav, demoModeToRp1Options(mode) || {}) : null;
      if (!section) {
        receipt =
          mode === "off"
            ? {
                decision: "not-applicable",
                status: "skipped",
                action: null,
                reasons: ["no World Navigator scope resolved (no RP1 parent->child attachment to authorize)"],
                fail_closed: true,
                evaluated_at: new Date().toISOString(),
              }
            : {
                decision: "deny",
                status: "rejected",
                action: "default-deny",
                reasons: [`demo mode ${mode} armed but no RP1 scope resolved (unknown condition => default-deny)`],
                fail_closed: true,
                evaluated_at: new Date().toISOString(),
              };
      } else {
        const childScopeRef =
          (nav.child_fabric && nav.child_fabric.url) ||
          (nav.portal_attachment && nav.portal_attachment.resolved_url) ||
          null;
        receipt = gateChildScopeTraversal({
          section,
          request: traversalRequestForDemoMode(mode, childScopeRef),
        });
      }
    } catch (e) {
      // FAIL-CLOSED on internal error: an evaluation the gate cannot complete is an
      // unknown condition — deny, with the error surfaced honestly.
      receipt = {
        decision: "deny",
        status: "rejected",
        action: "default-deny",
        reasons: [`gate internal error: ${(e && e.message) || "unknown"} (unknown condition => default-deny)`],
        fail_closed: true,
        evaluated_at: new Date().toISOString(),
      };
    }
    receipt.demo_mode = mode;
    this._rp1FailClosed.last_receipt = receipt;
    if (receipt.decision === "deny") this._rp1FailClosed.deny_count += 1;
    if (receipt.decision === "allow") this._rp1FailClosed.allow_count += 1;
    return receipt;
  }

  /** debugState() surface for the gate: mode, receipts, and the SCOPED honesty descriptor. */
  _rp1FailClosedDebug() {
    return {
      gate_wired: true,
      demo_mode: this._rp1FailClosed.demo_mode,
      available_modes: RP1_FAIL_CLOSED_MODES.slice(),
      last_receipt: this._rp1FailClosed.last_receipt,
      allow_count: this._rp1FailClosed.allow_count,
      deny_count: this._rp1FailClosed.deny_count,
      descriptor: { ...RP1_FAIL_CLOSED },
      scope_note:
        "RP1 fail-closed traversal gate: consulted before every portal commit. " +
        "stale attachment => deny-child-scope-traversal; revoked session => no replay/reuse; " +
        "denied spatial.crossWorldLinking => cross-scope link blocked (local-only); repeated " +
        "mounts refused; default-deny on unknown. Scoped flag only — um_conformance unchanged.",
    };
  }

  // Portal commit, phase history, player completion, signing/verification,
  // observer relay, and crossing evidence are owned by the traversal controller.
  async _promoteActiveEndpoint(targetKey, packet, isCurrent = () => true) {
    const navigationCurrent = this._beginWorldNavigation(isCurrent);
    const { base, world } = this;
    const current = () => navigationCurrent() && this.base === base && this.world === world;
    const previousRootContainer = this._navigator?.root_fabric?.container || this.world?.location_id || null;
    const prefetch = packet?.fabric_prefetch_proof || this._fabricPrefetchProofBlock(new Date().toISOString());
    const completion = this._fabricPrefetchController.capturePromotionInput(prefetch);
    const destination = await readNavigationDestination({ endpoint: ENDPOINTS[targetKey], role: this.role,
      transport: this._transport, isCurrent: current });
    if (!current() || !destination) return null;
    this._adoptNavigationDestination(targetKey, destination);
    this._closeRuntimeStream();
    this._connectRuntimeStream();
    const record = promotionRecord({ navigator: this._navigator, world: this.world,
      previousRootContainer, packet, marker: this._playerContextMarker, prefetch });
    this._fabricPrefetchController.recordPromotion(record, prefetch);
    this._resetFabricPrefetch("promoted_to_" + this.world.location_id);
    this._navigatorPromotions.push(record);
    if (this._navigator) {
      this._navigator.promotion_count = this._navigatorPromotions.length;
      this._navigator.last_promotion = record;
    }
    if (this._playerContextMarker) this._playerContextMarker.promotions = this._navigatorPromotions.slice();
    this._startFabricCompletion({ handoff_id: record.handoff_id, promotion_record: record, ...completion });
    return record;
  }

  _beginWorldNavigation(isCurrent = () => true) {
    const operation = this._worldNavigationOperation = {};
    this._nonPortalHandoffInFlight = false;
    this._wowReadOperation = this._wowSceneReadOperation = this._rootFabricReadOperation = null;
    this._wowEndpointReadOperation = this._navigatorReadOperation = null;
    return () => !this._disposed && this._worldNavigationOperation === operation && isCurrent();
  }

  _adoptNavigationDestination(targetKey, destination) {
    this._adoptNavigationResources(targetKey, destination);
    this._wowResolved = destination.scene.resolved;
    this._wowSceneSource = this._lastCrossingSceneSource = destination.scene.record;
    this._adoptLiveAirportScenePhysics(this._wowResolved);
    const check = validateProofBoundary(this.world.claim_boundary);
    this._boundaryOk = check.ok;
    this._boundaryProblems = check.problems;
    this._initPlayerPreview();
    this._adoptWorldNavigator(projectWorldNavigator({ base: this.base, rootFabric: destination.rootFabric,
      world: this.world, marker: this._playerContextMarker, promotions: this._navigatorPromotions }));
    for (const message of destination.messages) this._log(message);
  }

  _adoptNavigationResources(targetKey, destination) {
    this.activeEndpointKey = targetKey;
    this.previewEndpointKey = oppositeEndpointKey(targetKey);
    this.endpoint = destination.endpoint;
    this.previewEndpoint = this.previewEndpointKey ? ENDPOINTS[this.previewEndpointKey] : null;
    this.base = destination.base;
    this._portalId = destination.portalId;
    this.world = destination.world;
    this._rootFabricManifest = destination.rootFabric;
    this._rootFabricManifestUrl = destination.rootFabric ? `${this.base}/fabric.json` : null;
    this._wowEndpoints = destination.resolution.endpoints;
    this._wowEndpointResolution = destination.resolution;
    this._lastPortalSignature = destination.portalSignature;
  }

  /**
   * Mapped exit pose in the PROMOTED world, derived from the promoted fabric's
   * own portal-back node (bSubtype 255) + primary.camera (spawn pose): exit =
   * portal-back node + into-world direction * exit offset + right * preserved
   * lateral entry offset; yaw = frame-mapped entry yaw (falls back to the
   * fabric's own into-world direction). Cross-checked against the portal-frame
   * mapping carried in the handoff packet.
   */
  _fabricDerivedExitPose(frameMapping) {
    return deriveFabricExitPose(frameMapping, { root: this._rootFabricManifest, world: this.world,
      resolveGround: (x, z) => this._resolveAvatarGround(x, z) });
  }

  /**
   * exit pose at the TRAVERSED EDGE's counterpart portal.
   *
   * The frame mapping's mapped_exit_transform is the counterpart-derived exit —
   * `mapTransformBetweenPortalFrames` computes it from the crossing portal's
   * `target_frame` (the destination-side counterpart), so it is the SAME pose
   * the through-ring renders and the SAME frame P3's
   * exit-distance parity re-measures the landing against. Consuming it here is
   * how "the portal you walked through decides where you land" holds: the frame
   * mapping is keyed on the edge actually traversed, never on the manifest order
   * of the destination world's portal-attachment nodes.
   *
   * Height is ground-resolved; the attachment node that HOSTS this edge (the one
   * nearest the counterpart) is named for evidence ONLY — never as the position
   * source. `matches_frame_mapping` is true by construction here.
   */
  _counterpartExitPoseFromFrameMapping(frameMapping, mapped, root) {
    return counterpartExitPose(frameMapping, mapped, { root, world: this.world,
      resolveGround: (x, z) => this._resolveAvatarGround(x, z) });
  }

  /**
   * the REAL session-marker proof. Compares the frozen snapshot taken
   * at page load against a fresh read of the live in-memory marker + the
   * document's navigation entries AFTER the crossing. Never hardcoded: a full
   * page reload would recreate the marker (new random ids) and reset the
   * comparison to null, so equality here can only come from one continuous JS
   * context.
   */
  _recordMarkerCrossingComparison() {
    const marker = this._playerContextMarker;
    const atLoad = this._markerAtLoad;
    if (!marker || !atLoad) return null;
    let navEntryCount = 0;
    let navType = "unknown";
    try {
      const entries =
        typeof performance !== "undefined" && performance.getEntriesByType
          ? performance.getEntriesByType("navigation")
          : [];
      navEntryCount = entries ? entries.length : 0;
      navType = entries && entries[0] && entries[0].type ? entries[0].type : "unknown";
    } catch (e) {
      /* keep defaults */
    }
    const currentHref =
      typeof window !== "undefined" && window.location ? window.location.href : marker.current_href;
    const identityEqual =
      marker.marker_id === atLoad.marker_id &&
      marker.context_id === atLoad.context_id &&
      marker.created_at === atLoad.created_at;
    const noNewNavigation =
      navEntryCount === atLoad.navigation_entry_count_at_boot && currentHref === atLoad.boot_href;
    marker.same_marker_after_crossing = identityEqual && noNewNavigation;
    marker.crossing_comparison = {
      checked_at: new Date().toISOString(),
      method:
        "in-memory snapshot captured at load compared against a read after the crossing; a reload would recreate the marker and null this comparison",
      marker_id_at_load: atLoad.marker_id,
      marker_id_after_crossing: marker.marker_id,
      context_id_at_load: atLoad.context_id,
      context_id_after_crossing: marker.context_id,
      created_at_at_load: atLoad.created_at,
      created_at_after_crossing: marker.created_at,
      marker_identity_equal: identityEqual,
      navigation_entry_count_at_boot: atLoad.navigation_entry_count_at_boot,
      navigation_entry_count_after_crossing: navEntryCount,
      navigation_type_after_crossing: navType,
      href_at_boot: atLoad.boot_href,
      href_after_crossing: currentHref,
      no_new_navigation: noNewNavigation,
      same_js_context: identityEqual && noNewNavigation,
    };
    return { ...marker.crossing_comparison };
  }

  /**
   * profile (`msf.player-view-handoff.v0.1`) carried across the
   * crossing: UM-shaped portable user envelope + IWPS-shaped handshake, both
   * explicitly labeled as local proof vocabulary with NO conformance claim.
   */
  _crossingDebug() {
    return this._portalTraversalController.crossingDebug();
  }

  _applyDepartureMirror(packet) {
    return this._portalTraversalController.applyDepartureMirror(packet);
  }

  async _applyArrivalMirror(packet) {
    return this._portalTraversalController.applyArrivalMirror(packet);
  }

  async applyArrival(packet) {
    return this._portalTraversalController.applyLegacyArrival(packet);
  }

  async reset() {
    const current = this._beginWorldNavigation();
    this._portalTraversalController.cancel();
    let pendingRecompose = null;
    if (this.clientMode === "player") {
      // player reset restores the BOOT world as the root fabric — in
      // the same context (demotion mirrors promotion; still no reload).
      try {
        await this._transport.postJson(`${this.baseA}/reset`, {});
        if (!current()) return;
      } catch (e) {
        if (!current()) return;
        /* best effort */
      }
      try {
        await this._transport.postJson(`${this.baseB}/reset`, {});
        if (!current()) return;
      } catch (e) {
        if (!current()) return;
        /* best effort */
      }
      try {
        // the lobby node resets with the pair.
        await this._transport.postJson(`${BASE_LOBBY}/reset`, {});
        if (!current()) return;
      } catch (e) {
        if (!current()) return;
        /* best effort */
      }
      const demoted = this.activeEndpointKey !== this._bootEndpointKey;
      try {
        const destination = await readNavigationResources({ endpoint: ENDPOINTS[this._bootEndpointKey], role: this.role,
          transport: this._transport, isCurrent: current });
        if (!current() || !destination) return;
        this._adoptNavigationResources(this._bootEndpointKey, destination);
        this._airportWalkableSurface = null;
        this._movementBounds = null;
        const check = validateProofBoundary(this.world.claim_boundary);
        this._boundaryOk = check.ok;
        this._boundaryProblems = check.problems;
      } catch (e) {
        if (!current()) return;
        this._log(`reset: world refetch failed (${e.message}); keeping previous world`);
      }
      await this._initPlayerPreview();
      if (!current()) return;
      await this._initWorldNavigator(current);
      if (!current()) return;
      this.state.arrival_count = this.world.initial_arrival_count ?? 0;
      if (this._playerContextMarker) {
        this._playerContextMarker.same_marker_after_crossing = null;
        this._playerContextMarker.crossing_comparison = null;
      }
      this.state.player_handoff_profile = null;
      if (demoted) {
        this._closeRuntimeStream();
        this._connectRuntimeStream();
        pendingRecompose = {
          kind: "reset_demotion",
          to: endpointDebug(this.endpoint, this.world),
        };
      }
    } else {
      try {
        await this._transport.postJson(`${this.base}/reset`, {});
        if (!current()) return;
      } catch (e) {
        if (!current()) return;
        /* best effort */
      }
    }
    if (this._startsEmbodied) {
      this.state.phase = HANDOFF_PHASES.IDLE;
      this.state.handoff_id = null;
      this.state.last_handoff_direction = null;
      this.state.last_handoff_payload = null;
      this.state.last_pose_payload = null;
      this.state.avatar = {
        avatar_id: this.world.avatar.avatar_id,
        continuity_id: this.world.avatar.continuity_id,
        display_name: this.world.avatar.display_name,
        position: this.world.avatar.spawn_position.slice(),
        rotation_y: this.world.avatar.rotation_y,
        locomotion: this.state.controls,
        // keep the clean base avatar on the return-to-lobby respawn too.
        equippedItems: this._noDefaultEquipment ? [] : defaultEquippedItems(),
        avatar_variant: DEFAULT_AVATAR_VARIANT,
        preferred_height_m: null,
        _provenance: PROVENANCE.LIVE,
      };
      this.state.equipment_status = {
        validation: validateEquippedItems(this.state.avatar.equippedItems),
        items: this.state.avatar.equippedItems.map((item) => ({
          itemId: item.itemId,
          mode: item.mode,
          attachmentPoint: item.attachmentPoint,
          assetUri: item.assetUri,
          fetch_ok: null,
          visible_fallback: false,
          message: "source item path prepared; fetch checked on destination",
        })),
      };
    } else {
      this.state.phase = HANDOFF_PHASES.WAITING;
      this.state.handoff_id = null;
      this.state.last_handoff_direction = null;
      this.state.last_handoff_payload = null;
      this.state.last_pose_payload = null;
      this.state.avatar = null;
      this.state.equipment_status = null;
      this.state.arrival_count = 0;
    }
    this._jumpVelocity = 0;
    this._nonPortalHandoffInFlight = false;
    this.state.controls = initialSessionControls(this._startsEmbodied, "reset");
    this._portalTraversalController.reset({ reason: "reset", startsEmbodied: this._startsEmbodied });
    if (this.state.avatar) this.state.avatar.locomotion = { ...this.state.controls };
    this._updatePortalStatus();
    // pose-lane state resets with the view; the player re-publishes
    // its fresh spawn pose so a same-location observer re-syncs.
    this._peers.resetBroadcastState();
    this._broadcast({ type: "reset", role: this.role, at: Date.now() });
    if (this.clientMode === "player") this._maybeBroadcastPlayerPose({ force: true });
    this._emit();
    if (pendingRecompose) {
      this.dispatchEvent(new CustomEvent("crossing", { detail: pendingRecompose }));
    }
  }

  async returnToLobby() {
    if (this.clientMode !== "player") return { ok: false, reason: "not_player" };
    if (this._clientSceneController.active()) return this.returnFromClientSceneLoad();
    if (this.activeEndpointKey === "lobby") {
      return { ok: true, already_in_lobby: true, location_id: this.world ? this.world.location_id : null };
    }
    if (!ENDPOINTS.lobby) return { ok: false, reason: "missing_lobby_endpoint" };

    const current = this._beginWorldNavigation();
    this._portalTraversalController.cancel();
    const fromBase = this.base;
    const from = endpointDebug(this.endpoint, this.world);
    const previousAvatar = this.state.avatar ? JSON.parse(JSON.stringify(this.state.avatar)) : null;
    const handoffId = `return-to-lobby-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    this._nonPortalHandoffInFlight = true;
    this._fabricPrefetchController.cancelCompletion("return_to_lobby");

    try {
      await this._departPresence(fromBase, "return_to_lobby");
      if (!current()) return { ok: false, reason: "navigation_retired" };

      const destination = await readNavigationResources({ endpoint: ENDPOINTS.lobby, role: this.role,
        transport: this._transport, isCurrent: current });
      if (!current() || !destination) return { ok: false, reason: "navigation_retired" };
      this._adoptNavigationResources("lobby", destination);
      this._airportWalkableSurface = null;
      this._movementBounds = null;
      const check = validateProofBoundary(this.world.claim_boundary);
      this._boundaryOk = check.ok;
      this._boundaryProblems = check.problems;

      this.state.phase = HANDOFF_PHASES.IDLE;
      this.state.handoff_id = null;
      this.state.arrival_count = this.world.initial_arrival_count ?? 0;
      this.state.preview = null;
      this.state.portal_previews = null;
      this.state.last_handoff_direction = "return_to_lobby";
      this.state.last_handoff_payload = null;
      this.state.last_pose_payload = null;
      this.state.player_handoff_profile = null;
      this.state.controls.enabled = true;
      this.state.controls.moving = false;
      this.state.controls.movement_mode = "idle";
      this.state.controls.run_mode = false;
      this.state.controls.speed_mps = 0;
      this.state.controls.grounded = true;
      this.state.controls.jump_height_m = 0;
      this.state.controls.movement_direction = "none";
      this.state.controls.last_planar_delta = [0, 0, 0];
      this.state.controls.facing_semantics = "still";
      this.state.controls.portal_transition_phase = "none";
      this.state.controls.portal_transition_elapsed_s = 0;
      this.state.controls.portal_transition_phase_history = [];
      this.state.controls.portal_trigger_rearmed = true;
      this.state.controls.portal_rearm_required = false;
      this.state.controls.portal_exited_since_arrival = true;
      this.state.controls.portal_ready_blocker = "return_to_lobby";
      this.state.controls.auto_handoff_ready = false;
      this.state.controls.inside_portal_trigger = false;

      const carriedItems =
        previousAvatar && Array.isArray(previousAvatar.equippedItems)
          ? previousAvatar.equippedItems
          : defaultEquippedItems();
      this.state.avatar = {
        avatar_id: previousAvatar ? previousAvatar.avatar_id : this.world.avatar.avatar_id,
        continuity_id:
          previousAvatar && previousAvatar.continuity_id
            ? previousAvatar.continuity_id
            : this.world.avatar.continuity_id,
        display_name:
          previousAvatar && previousAvatar.display_name
            ? previousAvatar.display_name
            : this.world.avatar.display_name,
        position: this.world.avatar.spawn_position.slice(),
        rotation_y: this.world.avatar.rotation_y,
        locomotion: this.state.controls,
        equippedItems: carriedItems,
        avatar_variant:
          previousAvatar && previousAvatar.avatar_variant
            ? previousAvatar.avatar_variant
            : DEFAULT_AVATAR_VARIANT,
        _provenance: PROVENANCE.LIVE,
      };
      this.state.equipment_status = {
        validation: validateEquippedItems(carriedItems),
        items: carriedItems.map((item) => ({
          itemId: item.itemId,
          mode: item.mode,
          attachmentPoint: item.attachmentPoint,
          assetUri: item.assetUri,
          fetch_ok: null,
          visible_fallback: false,
          message: "carried through return-to-lobby navigation",
        })),
      };

      await this._initPlayerPreview();
      if (!current()) return { ok: false, reason: "navigation_retired" };
      await this._initWorldNavigator(current);
      if (!current()) return { ok: false, reason: "navigation_retired" };
      this._jumpVelocity = 0;
      if (current()) this._nonPortalHandoffInFlight = false;
      this._portalTraversalController.reset({ reason: "return_to_lobby", startsEmbodied: true });
      this._resetFabricPrefetch("return_to_lobby");
      this._closeRuntimeStream();
      this._connectRuntimeStream();
      await this._registerPresence("return_to_lobby");
      if (!current()) return { ok: false, reason: "navigation_retired" };
      this._maybeBroadcastPlayerPose({ force: true });
      this._emit();

      const detail = {
        kind: "return_to_lobby",
        handoff_id: handoffId,
        from,
        to: endpointDebug(this.endpoint, this.world),
        same_context: true,
        no_page_reload: true,
      };
      this.dispatchEvent(new CustomEvent("crossing", { detail }));
      return { ok: true, ...detail };
    } catch (err) {
        if (!current()) return { ok: false, reason: "navigation_retired" };
      if (current()) this._nonPortalHandoffInFlight = false;
      this._log(`return-to-lobby failed: ${err.message}`);
      this._emit();
      return { ok: false, reason: err.message };
    }
  }

  _activeDebug() {
    return endpointDebug(this.endpoint, this.world);
  }

  _previewDebug() {
    if (this.state.preview) {
      const freshness = previewFreshnessMs(this.state.preview.captured_at);
      return {
        ...this.state.preview,
        freshness_ms: freshness,
        preview_freshness_ms: freshness,
        preview_source_type: this.state.preview.source_type,
        preview_readonly: this.state.preview.readonly === true,
        preview_target_location_id: this.state.preview.location_id,
        preview_target_world_id: this.state.preview.world_id,
        preview_target_portal_id: this.state.preview.target_portal_id,
        preview_fallback_reason: this.state.preview.fallback_reason,
      };
    }
    if (!this.previewEndpoint) {
      return {
        state: "none",
        source_type: "none",
        preview_source_type: "none",
        readonly: true,
        preview_readonly: true,
        endpoint_key: null,
        proxy_base: null,
        backend_base_url: null,
        location_id: null,
        preview_target_location_id: null,
        world_id: null,
        preview_target_world_id: null,
        target_portal_id: null,
        preview_target_portal_id: null,
        linked_source_portal_id: null,
        freshness_ms: null,
        preview_freshness_ms: null,
        captured_at: null,
        fallback_reason: null,
        preview_fallback_reason: null,
        projection_frame_source: null,
        target_arrival_count_before_preview: null,
        target_arrival_count_current: null,
        target_state_revision_before_preview: null,
        target_state_revision_current: null,
        target_handoff_context_before_preview: false,
        target_handoff_context_current: false,
        target_debug_last_input_source: null,
        target_avatar_presence_created: false,
        target_mutation_count_during_preview: 0,
        source_camera_relative_to_portal: {},
        target_preview_camera_transform: {},
        preview_projection_transform: {},
      };
    }
    return {
      state: "inactive",
      source_type: "none",
      preview_source_type: "none",
      readonly: true,
      preview_readonly: true,
      endpoint_key: this.previewEndpoint.endpoint_key,
      proxy_base: this.previewEndpoint.proxy_base,
      backend_base_url: this.previewEndpoint.backend_base_url,
      location_id: this.previewEndpoint.location_id,
      preview_target_location_id: this.previewEndpoint.location_id,
      world_id: this.previewEndpoint.world_id,
      preview_target_world_id: this.previewEndpoint.world_id,
      target_portal_id: this.previewEndpoint.portal_id,
      preview_target_portal_id: this.previewEndpoint.portal_id,
      linked_source_portal_id: this.endpoint.portal_id,
      freshness_ms: null,
      preview_freshness_ms: null,
      captured_at: null,
      fallback_reason: null,
      preview_fallback_reason: null,
      projection_frame_source: "source_portal_frame+target_portal_frame",
      target_arrival_count_before_preview: null,
      target_arrival_count_current: null,
      target_state_revision_before_preview: null,
      target_state_revision_current: null,
      target_handoff_context_before_preview: false,
      target_handoff_context_current: false,
      target_debug_last_input_source: null,
      target_avatar_presence_created: false,
      target_mutation_count_during_preview: 0,
      source_camera_relative_to_portal: {},
      target_preview_camera_transform: {},
      preview_projection_transform: {},
    };
  }

  _playerContextMarkerDebug() {
    if (!this._playerContextMarker) return null;
    const currentHref = typeof window !== "undefined" && window.location
      ? window.location.href
      : this._playerContextMarker.current_href;
    this._playerContextMarker.current_href = currentHref;
    return { ...this._playerContextMarker };
  }

  /**
   * freeze the render-facing source projection while an
   * already-authorized destination is assembled. Internal transport/promotion
   * state may continue, but the renderer, avatar host, camera loop, and HUD all
   * read this coherent source snapshot until commitVisualTransition().
   */
  beginVisualTransition(metadata = {}) {
    if (this._visualTransitionSnapshot) {
      throw new Error("a visual transition is already staged");
    }
    const sourceDebug = this.debugState();
    const state = snapshotVisualState(this.state, snapshotRenderFacingAvatar);
    this._visualTransitionSnapshot = {
      metadata: { ...metadata },
      staged_at: new Date().toISOString(),
      state,
      liveAvatar: this.state.avatar,
      liveControls: this.state.controls,
      world: this.world,
      base: this.base,
      activeEndpointKey: this.activeEndpointKey,
      previewEndpointKey: this.previewEndpointKey,
      endpoint: this.endpoint,
      previewEndpoint: this.previewEndpoint,
      portalId: this._portalId,
      activeDebug: this._activeDebug(),
      previewDebug: this._previewDebug(),
      sourceDebug,
      infrastructure: {
        wowEndpoints: this._wowEndpoints,
        wowEndpointResolution: this._wowEndpointResolution,
        wowSceneSource: this._wowSceneSource,
        lastCrossingSceneSource: this._lastCrossingSceneSource,
        boundaryOk: this._boundaryOk,
        boundaryProblems: this._boundaryProblems,
        navigator: this._navigator,
        childFabricManifest: this._childFabricManifest,
        rootFabricManifest: this._rootFabricManifest,
      },
    };
    return this.visualRuntimeSnapshot();
  }

  visualRuntimeSnapshot() {
    return visualRuntimeProjection(this._visualTransitionSnapshot, {
      state: this.state, world: this.world, base: this.base,
      activeEndpointKey: this.activeEndpointKey, previewEndpointKey: this.previewEndpointKey,
    });
  }

  visualDebugState() {
    return visualDebugProjection(this._visualTransitionSnapshot, this.debugState());
  }

  commitVisualTransition({ emit = false } = {}) {
    if (!this._visualTransitionSnapshot) return false;
    this._visualTransitionSnapshot = null;
    if (emit) this._emit();
    return true;
  }

  abortVisualTransition({ restore = false } = {}) {
    const staged = this._visualTransitionSnapshot;
    if (!staged) return false;
    if (restore) {
      this.activeEndpointKey = staged.activeEndpointKey;
      this.previewEndpointKey = staged.previewEndpointKey;
      this.endpoint = staged.endpoint;
      this.previewEndpoint = staged.previewEndpoint;
      this.base = staged.base;
      this._portalId = staged.portalId;
      this.world = staged.world;
      restoreVisualState(this.state, staged, snapshotRenderFacingAvatar);
      const infrastructure = staged.infrastructure;
      this._wowEndpoints = infrastructure.wowEndpoints;
      this._wowEndpointResolution = infrastructure.wowEndpointResolution;
      this._wowSceneSource = infrastructure.wowSceneSource;
      this._lastCrossingSceneSource = infrastructure.lastCrossingSceneSource;
      this._boundaryOk = infrastructure.boundaryOk;
      this._boundaryProblems = infrastructure.boundaryProblems;
      this._navigator = infrastructure.navigator;
      this._childFabricManifest = infrastructure.childFabricManifest;
      this._rootFabricManifest = infrastructure.rootFabricManifest;
    }
    this._visualTransitionSnapshot = null;
    return true;
  }

  /** /debug/state-shaped snapshot, matching Lane 1's fixture debugState() shape. */
  debugState() {
    const proofBoundary = strictProofBoundary(this.world && this.world.claim_boundary);
    const traversal = this._portalTraversalController.debug();
    return projectLiveDebug(this.world, this.state, {
      role: this.role,
      mode: this.mode,
      clientMode: this.clientMode,
      provenance: PROVENANCE.LIVE,
      active: this._activeDebug(),
      preview: this._previewDebug(),
      controlledIdentity: this.controlledIdentity(),
      playerContextMarker: this._playerContextMarkerDebug(),
      navigator: this._navigatorDebug(),
      traversal,
      clientSceneLoad: this._clientSceneController.debug(),
      wowSceneSource: this._wowSceneSource,
      umIdentity: this._umIdentity,
      rp1FailClosed: this._rp1FailClosedDebug(),
      fabricPrefetch: this._fabricPrefetchDebug(),
      presence: this._presenceDebug(),
      presencePush: this._presencePushDebug(),
      endpointResolution: this._wowEndpointResolution,
      viewMatch: this._viewMatch,
      visibility: this._visibilityDebug(),
      livePose: this._peers.livePoseDebug(),
      peers: this._peerPlayersDebug(),
      peerCount: this._coPresentPeerCount(),
      poseBroadcast: this._playerPoseBroadcastDebug(),
      avatarGeoPose: this.state.avatar
        ? geoPoseShapedFromTransform(transformSnapshot(this.state.avatar))
        : null,
      proofBoundary,
      boundaryStatus: this.boundaryStatus(),
    });
  }

  /* ---------------- Web of Worlds API panel surface --------
   * Read-only + presenter-interaction helpers for the API activity panel. NONE
   * of these touch the crossing state machine; they are opt-in operator actions
   * over endpoints that already exist (the same two POST endpoints the crossing
   * uses as server-side notifications, plus the read-only /wow + /fabric GETs).
   * The presenter POSTs go through the SAME getJson/postJson seam, so every one
   * of them also shows up in the live request log. */

  /** Spec identity + the services[] the loaded root fabric advertises. */
  apiPanelInfo() {
    const active = this.endpoint;
    const targetKey =
      oppositeEndpointKey(this.activeEndpointKey) ||
      endpointKeyForLocation(
        this.world && this.world.portal ? this.world.portal.target_location_id : null
      ) ||
      "a";
    const target = ENDPOINTS[targetKey];
    return projectApiPanel(active, target, {
      root: this._rootFabricManifest,
      world: this.world,
      resolution: this._wowEndpointResolution,
      viewMatch: this._viewMatch,
      validation: this._transport.wowContractValidationSnapshot(),
      specIdentity: SPEC_IDENTITY,
    });
  }

  /**
   * Fetch one active-world resource for a click-to-inspect chip. `kind` is one
   * of world|user|portal|view|fabric. For user/portal/view an integer id is
   * accepted (spec integer route) — a bad id shows the spec 404 live. Portal
   * defaults to this world's string alias id when no explicit id is given.
   * Returns { ok, status, url, schema, json } and never throws (the 404 body IS
   * the demonstrable payload).
   */
  async apiFetchEndpoint(kind, id) {
    return fetchLiveApiEndpoint(
      this._transport,
      { base: this.base, portalId: this._portalId },
      kind,
      id
    );
  }

  /**
   * Presenter "Exit via API": POST /portal/exit-intent on the ACTIVE base and
   * return the real handoff packet for the panel to hold + display + edit. This
   * does NOT drive the crossing (it does not touch traversal-controller state or phase);
   * it is a standalone demonstration POST against the endpoint that already
   * exists. The packet is client-held: editing target.arrival_position before
   * delivery needs no server change.
   */
  async presenterExitIntent() {
    return postPresenterExit(
      this._transport,
      `${this.base}/portal/exit-intent`,
      this._portalId,
      () => this.activeEndpointKey
    );
  }

  /**
   * Presenter "Deliver arrival": POST a (possibly edited) handoff packet to a
   * world-server's /portal/arrival and report the arrival_count before/after so
   * the panel can prove a delta of exactly 1. `opts.toWrongNode` deliberately
   * targets the SOURCE node instead of the packet's real target, surfacing the
   * live drift-guard/contract-validation 400 (runtime-state guards that the
   * arrival's target.location_id/world_id match the receiving node). Server is
   * unchanged; this only exercises endpoints that already exist.
   */
  async presenterDeliverArrival(packet, opts = {}) {
    const pkt = packet && typeof packet === "object" ? packet : {};
    const target = pkt.target || {};
    const realTargetKey =
      endpointKeyForLocation(target.location_id) ||
      oppositeEndpointKey(this.activeEndpointKey) ||
      endpointKeyForLocation(
        this.world && this.world.portal ? this.world.portal.target_location_id : null
      ) ||
      "a";
    const wrongKey = oppositeEndpointKey(realTargetKey) || this.activeEndpointKey;
    const deliverKey = opts.toWrongNode ? wrongKey : realTargetKey;
    const deliverBase = ENDPOINTS[deliverKey].proxy_base;
    return postPresenterArrival(this._transport, pkt, { deliverKey, deliverBase }, opts);
  }

  _emit(opts = {}) {
    if (this._disposed) return;
    const detail = this.visualDebugState();
    this.dispatchEvent(new CustomEvent("state", { detail }));
    if (opts.broadcastVisibility !== false) this._broadcastVisibility();
  }
  _log(msg) {
    console.log(`[live-adapter:${this.role}] ${msg}`);
  }

  /**
   * begin the CONTINUOUS walk-through crossing. Called by
   * _updatePortalStatus the instant the avatar's position crosses the portal
   * plane inside the oval (and by triggerHandoff for the operator path). The
   * avatar is NOT centered, NOT held, NOT spun, NOT shrunk — its live
   * transform at the plane is the entry pose, the frame mapping mirrors it
   * through the target portal, and the handoff commits on this same tick.
   */
  _beginPortalTransition(source, portalArg) {
    return this._portalTraversalController.beginTransition({ source, portal: portalArg });
  }

  _stepPortalTransition(dt) {
    const result = this._portalTraversalController.stepTransition({ deltaSeconds: dt });
    if (!result.moved) return this.state.controls;
    this._updatePortalStatus({ skipTransitionStart: true });
    this._maybeBroadcastPlayerPose();
    this._emit();
    return this.state.controls;
  }

  _updatePortalStatus(opts = {}) {
    const result = this._portalTraversalController.updatePortalStatus(opts);
    if (result && result.transitionRequest) {
      const ev = result.transitionRequest;
      this._beginPortalTransition("plane_crossing", ev.portal);
      return;
    }
    const avatar = result && result.avatar;
    const evaluations = result && result.evaluations ? result.evaluations : [];
    if (this.clientMode === "player" && avatar) {
      try {
        this._updateFabricPrefetch(avatar, evaluations);
      } catch (e) {
        /* prefetch is additive — a prefetch fault must never break the tick */
      }
    }
    return result;
  }
  _fabricProxyBaseForAddress(address) {
    if (address) {
      for (const key of Object.keys(ENDPOINTS)) {
        if (address.location_id && ENDPOINTS[key].location_id === address.location_id) {
          return ENDPOINTS[key].proxy_base;
        }
      }
      for (const key of Object.keys(ENDPOINTS)) {
        if (address.authority && ENDPOINTS[key].backend_base_url === address.authority) {
          return ENDPOINTS[key].proxy_base;
        }
      }
    }
    return this.previewEndpoint ? this.previewEndpoint.proxy_base : null;
  }

  _resetFabricPrefetch(reason) {
    return this._fabricPrefetchController.reset({
      reason,
      world: this.world,
      clientMode: this.clientMode,
    });
  }

  _fabricPrefetchFocusMachine() {
    const machines = this._fabricPrefetchMachines || {};
    const focusKey =
      this.state && this.state.controls ? this.state.controls.portal_focus_portal_id : null;
    if (focusKey && machines[focusKey]) return machines[focusKey];
    const keys = Object.keys(machines);
    return keys.length ? machines[keys[0]] : null;
  }

  _updateFabricPrefetch(avatar, evaluations) {
    return this._fabricPrefetchController.update({
      avatar,
      evaluations,
      focusPortalId:
        this.state && this.state.controls ? this.state.controls.portal_focus_portal_id : null,
      world: this.world,
      clientMode: this.clientMode,
    });
  }

  _refreshFabricPresence(machine) {
    return this._fabricPrefetchController.refreshPresence(machine);
  }

  notifyFabricChunkRendered(portalKey, chunksRendered) {
    return this._fabricPrefetchController.notifyChunkRendered(portalKey, chunksRendered);
  }

  _fabricPrefetchDebug() {
    return this._fabricPrefetchController.debug({
      focusPortalId:
        this.state && this.state.controls ? this.state.controls.portal_focus_portal_id : null,
    });
  }

  _fabricPrefetchProofBlock(commitIso, portalKey) {
    return this._fabricPrefetchController.proofBlock(commitIso, portalKey);
  }

  _startFabricCompletion(context) {
    return this._fabricPrefetchController.startCompletion(context);
  }

  _fabricCompletionDebug() {
    return this._fabricPrefetchController.completionDebug();
  }
  /* ---------------- server-side presence registration ----
   * The player session explicitly registers/heartbeats/departs against its
   * CURRENT active server so that server's per-location registry (the one
   * presence truth behind /fabric/presence occupancy and
   * session.connected_clients) knows its real players. Rules:
   *   - PLAYER windows only (observers never register);
   *   - always against this.base (own active server) — never against the
   *     prefetch destination; prefetch presence reads stay GET-only;
   *   - every call is best-effort and never throws into init/crossing paths;
   *   - the server-side TTL is the backstop for anything lost (crashed tab,
   *     dropped depart, heartbeat/depart race at a crossing).
   */

  /**
   * apply a WoW intent parsed from the URL fragment, LIVE (on
   * `hashchange`, with no reload). Editing the hash from `#preview` to `#join` must actually
   * join you; editing it back must actually remove you from the world.
   *
   * This DRIVES the existing presence machinery — it reuses `_registerPresence` /
   * `_departPresence` / the heartbeat loop exactly as the crossing and lobby-return paths do.
   * It rebuilds nothing and adds no endpoint.
   *
   * Ordering matters: `_departPresence` early-returns when `_presence.supported` is false, so
   * we must depart BEFORE lowering the gate, and raise the gate BEFORE registering.
   */
  async applyWowIntent(next) {
    if (!next) return null;
    const wasRegistering = this._wowRegistersPresence;
    this.wowIntent = next;
    this._wowRegistersPresence = next.registersPresence !== false;
    this.wowFollowTarget = next.followTarget || null;

    // Observers (the SERVER A/B inspector windows) never registered presence to begin with.
    if (this.clientMode !== "player") return null;
    if (wasRegistering === this._wowRegistersPresence) {
      return { intent: next.intent, registersPresence: this._wowRegistersPresence, changed: false };
    }

    if (this._wowRegistersPresence) {
      // preview -> join/follow: become a real user in the world.
      this._presenceController.setSupported(true);
      await this._registerPresence("wow_intent_" + next.intent);
    } else {
      // join/follow -> preview: leave the world, then close the gate so the heartbeat and any
      // later register are refused (the same gate every observer window runs under).
      await this._departPresence(this.base, "wow_intent_preview");
      this._stopPresenceHeartbeat();
      this._presenceController.setSupported(false);
      this._presenceController.clearRegistration();
    }
    this._presenceController.recordEvent("wow_intent", {
      intent: next.intent,
      aspect_id: next.aspectId || null,
      registers_presence: this._wowRegistersPresence,
    });
    return { intent: next.intent, registersPresence: this._wowRegistersPresence, changed: true };
  }

  /**
   * authoritative "leave session" for in-app exits that are
   * NOT a browser navigation. The HOME button hides the app in-DOM (no `pagehide`
   * fires), so without an explicit leave the 3s presence heartbeat keeps
   * refreshing the server TTL and lobby/room occupancy only ever climbs. This
   * DRIVES the existing presence machinery exactly like the wowIntent teardown:
   * stop the heartbeat, depart the current active server (beacon so the depart
   * survives an imminent unload), clear the local registration, and close the
   * live streams. Player windows only; `supported` is left intact so
   * `resumeSession()` can re-add the player when the launcher is dismissed.
   */
  async leaveSession(reason = "leave_session") {
    const current = this._beginWorldNavigation();
    this._portalTraversalController.cancel();
    if (this.clientMode !== "player") return null;
    this._stopPresenceHeartbeat();
    await this._departPresence(this.base, reason, { beacon: true });
    if (!current()) return null;
    this._presenceController.clearRegistration();
    this._closeRuntimeStream();
    this._closePresenceEventStreams();
    this._presenceController.recordEvent("leave_session", { reason });
    return { ok: true, reason };
  }

  /**
   * symmetric resume for `leaveSession`. Re-registers the
   * player with the current active server, restarts the heartbeat
   * (registerPresence restarts it in its `finally`), and reconnects the live
   * streams. Mirrors the boot spawn sequence (register -> connect runtime stream
   * -> sync presence event streams -> emit -> broadcast pose). Used when the HOME
   * launcher is dismissed back to the running app. Player windows only.
   */
  async resumeSession(reason = "resume_session") {
    if (this.clientMode !== "player") return null;
    const output = await this._registerPresence(reason);
    this._startPresenceHeartbeat();
    this._connectRuntimeStream();
    this._syncPresenceEventStreams();
    this._emit();
    this._maybeBroadcastPlayerPose({ force: true });
    return { ok: true, reason, registered: !!output };
  }

  /** Stable controlled-session identity used by presence, handoff, peers, and
   * portal-preview self suppression. This key survives every in-page A/B/lobby
   * transition; it deliberately makes no reload-stable/account-auth claim. */
  controlledIdentity() {
    return this._presenceController.controlledIdentity();
  }

  departPresence(input = {}) {
    return this._presenceController.departPresence(input);
  }

  stopPresenceHeartbeat() {
    return this._presenceController.stopHeartbeat();
  }

  registerPresence(input = {}) {
    return this._presenceController.registerPresence(input);
  }

  presenceSnapshot() {
    return this._presenceController.snapshot();
  }

  clearPresenceRegistration() {
    return this._presenceController.clearRegistration();
  }

  closeRuntimeStream() {
    return this._runtimeStreams.closeRuntimeStream();
  }

  connectRuntimeStream(endpointKey) {
    return this._runtimeStreams.connectRuntimeStream(endpointKey);
  }

  syncPresenceEventStreams(endpointKeys) {
    return this._runtimeStreams.syncEventStreams(endpointKeys);
  }

  peerPresenceSnapshot() {
    return this._peers.snapshot();
  }

  clearPeerPresence() {
    return this._peers.clear();
  }

  restorePeerPresence(snapshot) {
    return this._peers.restore(snapshot);
  }

  async _registerPresence(reason) {
    return this._presenceController.registerPresence({ spawnReason: reason });
  }

  /** Depart an explicit base (old server at a crossing; current on pagehide). */
  async _departPresence(base, reason, opts = {}) {
    return this._presenceController.departPresence({ base, reason, beacon: opts.beacon === true });
  }

  _startPresenceHeartbeat() {
    return this._presenceController.startHeartbeat();
  }

  _stopPresenceHeartbeat() {
    return this._presenceController.stopHeartbeat();
  }

  async _heartbeatPresence() {
    return this._presenceController.heartbeat();
  }

  _installPresencePageHide() {
    return this._presenceController.installPagehide();
  }

  /** debugState() projection of the registration lifecycle (evidence surface). */
  _presenceDebug() {
    return this._presenceController.debug();
  }

  _presenceEventEndpointKeys() {
    if (this._clientSceneController.active() || this._wowLocalWalk) return [];
    // Only the world the visitor is in: a destination is not read until its portal is neared.
    return ENDPOINTS[this.activeEndpointKey] ? [this.activeEndpointKey] : [];
  }

  _closePresenceEventStream(endpointKey) {
    return this._runtimeStreams.closeEventStream(endpointKey);
  }

  _closePresenceEventStreams() {
    return this._runtimeStreams.closeEventStreams();
  }

  _syncPresenceEventStreams() {
    return this._runtimeStreams.syncEventStreams();
  }

  _openPresenceEventStream(endpointKey) {
    return this._runtimeStreams.openEventStream(endpointKey);
  }

  _applyPresenceDeparture(endpointKey, message) {
    const playerId =
      (message && message.user && message.user.player_id) ||
      (message && message.player_id) ||
      null;
    const receivedAtMs = Date.now();
    const targetLocationId = ENDPOINTS[endpointKey] ? ENDPOINTS[endpointKey].location_id : null;
    const record = {
      type: "user_left",
      endpoint_key: endpointKey,
      target_location_id: targetLocationId,
      player_id: playerId,
      server_event_at: message && message.at ? message.at : null,
      received_at: new Date(receivedAtMs).toISOString(),
      received_at_ms: receivedAtMs,
      peer_pose_removed: 0,
      prefetch_presence_removed: 0,
      prefetch_snapshot_removed: 0,
      lobby_occupancy_removed: 0,
      affected_portal_keys: [],
      presence_refresh_count_before: {},
      presence_refresh_count_after: {},
      next_poll_due_at_ms: null,
      stale_prune_due_at_ms: null,
      ttl_fallback_due_at_ms: receivedAtMs + PRESENCE_TIMING.requested_ttl_ms,
      invalid_payload: !playerId,
    };

    if (playerId) {
      Object.assign(record, this._peers.removeDepartedPlayer({
        playerId,
        locationId: targetLocationId,
        endpointKey,
        message,
        receivedAtMs,
      }));
    }

    record.cache_invalidated_at_ms = Date.now();
    record.removed_total =
      record.peer_pose_removed +
      record.prefetch_presence_removed +
      record.prefetch_snapshot_removed +
      record.lobby_occupancy_removed;
    record.event_to_cache_ms = record.cache_invalidated_at_ms - receivedAtMs;
    return record;
  }

  _emitPresenceDeparture(record) {
    if (!record) return false;
    record.emit_started_at_ms = Date.now();
    this._emit({ broadcastVisibility: false });
    record.emit_completed_at_ms = Date.now();
    record.event_to_render_emit_ms = record.emit_completed_at_ms - record.received_at_ms;
    return record.removed_total > 0;
  }

  _applyPresenceDepartureProjections(input) {
    // Compatibility ownership trace: the controller records the canonical
    // presence_user_left_push event while this Patch-13 callback stays stable.
    return this._fabricPrefetchController.removePresencePlayer(input);
  }
  _presencePushDebug() {
    return this._runtimeStreams.debug();
  }

  _connectRuntimeStream() {
    return this._runtimeStreams.connectRuntimeStream();
  }

  _closeRuntimeStream() {
    return this._runtimeStreams.closeRuntimeStream();
  }

  _localVisibleAvatarCount() {
    const avatar = this.state.avatar;
    if (!avatar) return 0;
    return avatar.transition_visual && avatar.transition_visual.visible === false ? 0 : 1;
  }

  _visibilityDebug() {
    return this._peers.visibilityDebug();
  }

  _broadcastVisibility() {
    return this._peers.broadcastVisibility();
  }

  /* ------------- live same-location avatar-pose continuity -----------
   * The PLAYER broadcasts a THROTTLED `type:"player-pose"` message (position,
   * rotation_y, locomotion state, location id, client id, continuity id) on
   * the EXISTING lane5 channel. The observer whose ACTIVE location matches
   * applies the pose to its ONE existing avatar via the same avatar/equipment
   * render path, so walking the player is visible LIVE in that observer.
   * Invariants preserved by construction:
   *   - one-avatar: a pose only MOVES the observer's single existing avatar;
   *     it never creates, duplicates, or resurrects one.
   *   - read-only preview (REQ-052): applying a pose is display-state in the
   *     receiving window only — no backend request is made; the pre-crossing
   *     target observer ignores it (location mismatch AND no avatar to move).
   * Cross-location pre-crossing continuity (target observer showing the
   * player in B BEFORE the crossing) is DEFERRED per the audit. */

  _playerPoseBroadcastDebug() {
    return this._peers.playerPoseDebug();
  }

  _maybeBroadcastPlayerPose(opts = {}) {
    return this._peers.broadcastPlayerPose(opts);
  }

  _applyPlayerPoseMirror(msg) {
    return this._peers.applyPlayerPoseMirror(msg);
  }

  /* ---------- keyed player presence ------------------
   * Player windows record other player poses for co-presence. Observer/server
   * windows record every player pose for their current location so server A/B
   * views render all real players rather than collapsing them into one mirrored
   * avatar. Self-poses are ignored in player mode. The peer's location is
   * carried so stale cross-location avatars drop immediately across a portal. */
  _recordPeerPlayerPose(msg) {
    return this._peers.recordPeerPlayerPose(msg);
  }

  /** peer players known to this window, with a
   * co_present flag = same active world as this client (renderable here). Stale
   * peers (silent past PEER_PLAYER_POSE_STALE_MS) are pruned so a closed peer
   * tab cannot leave a ghost avatar. */
  _peerPlayersDebug() {
    return this._peers.peerPlayersDebug();
  }

  /** count of tracked players rendered in this world. */
  _coPresentPeerCount() {
    return this._peers.coPresentPeerCount();
  }

  _channel() {
    return this._peers.channel();
  }
  _broadcast(msg) {
    return this._peers.broadcast(msg);
  }
  listenForCrossWindow() {
    this._peers.listenForCrossWindow();
    return this;
  }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._beginWorldNavigation();
    this._portalTraversalController.cancel();
    this._fabricPrefetchController.dispose();
    this._runtimeStreams.dispose();
    this._presenceController.dispose();
    this._peers.dispose();
  }

  _finishMovementStep(dt, result) {
    this._jumpVelocity = result.velocity;
    if (!result.active) return this.state.controls;
    this._updatePortalStatus();
    this._serverSyncMs += dt * 1000;
    if (result.moving && this._serverSyncMs >= 250) {
      this._serverSyncMs = 0;
      if (!this._wowLocalWalk) this._transport.postJson(`${this.base}/movement`, {
        forward: result.forward, strafe: result.strafe, turn: 0, source: "browser-real-avatar-controls",
      }).catch(() => {});
    }
    this._maybeBroadcastPlayerPose();
    this._emit();
    return this.state.controls;
  }
}
