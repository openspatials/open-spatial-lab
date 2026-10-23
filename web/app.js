/**
 * app.js — Integration Assembly frontend orchestration.
 *
 * This is Lane 1's app.js with the ONE documented swap applied:
 *   FixtureAdapter  ->  LiveAdapter (live Lane 3 backend).
 * Lane 1's Scene (Three.js FALLBACK verifier) and frontend-contract are reused
 * UNMODIFIED (served from ./vendor/scene-core/, which is Lane 1's public/). The
 * LiveAdapter's control methods are async (real HTTP), so the click handlers
 * await them; everything else is identical Lane 1 logic.
 *
 * window.__assembly is exported for the headless e2e driver to drive the four
 * evidence states deterministically against the live backend.
 */

import { LiveAdapter, API_EVENTS } from "./live-adapter.js?v=runtime";
import {
  AvatarEquipmentLayer,
  AVATAR_VARIANTS,
  cloneGltfSceneAsset,
  loadGltfSceneAsset,
} from "./avatar-equipment-layer.js";
// seamless portal aperture render — the prefetched
// destination fabric rendered spatially through the ring + crossing takeover.
// static Three.js scene builder for a VERIFIED
// OMB fabric manifest (the reader lives in the adapter; THREE is injected here).
// `assertMsfRenderable` is the ONE fail-closed render gate
// (shared with the reader + the child-fabric policy) — a tampered/unverified
// fabric is REFUSED here, never drawn, and its map.wasm is never executed.
// additive render seam builder
// that walks a WoW Spatial Composition Graph (/wow/spatial nodes -> 4x4
// column-major localTransform -> three.js) into the SAME {scene,camera} the msf
// builders return. Primary render source for a WoW world; the .msf/procedural
// builders are DEFERRED, kept in place, not deleted.
// mountWowSceneAssets is the ASYNC ingest pass that
// loads each node's real glTF `spatialAssetURI` into its group (placeholder until
// loaded; labeled fallback on error), reusing the avatar GLTFLoader stack above.
import { buildWowScene, mountWowSceneAssets } from "./wow-scene.mjs";
import { mountLiveInclusions, environmentAwareClone } from "./wow-inclusion-mount.mjs";
// optional airport content presentation mounted only when
// a WoW fixture explicitly declares the labeled airport-terminal extension.
import { mountAirportTerminalContent } from "./airport-terminal-scene.mjs";
import {
  airportSceneContract,
  resolveClientSceneLoadTraversal,
} from "./airport-lobby-transition.mjs";
// the scoped IWPS v0.3 Query+Teleport conformance descriptor + label,
// shared with the adapter (single source of truth) so the panel reads the same scoped
// truth the wire emits.
import { IWPS_CONFORMANCE } from "./iwps-query-teleport.mjs";
// the scoped `um_conformance` descriptor (v0.1-baseline via the UM
// conformance runner). Single source of truth = web/conformance/um-conformance.mjs, backed
// by the re-runnable gate web/conformance/run-um-conformance.mjs.
import { UM_CONFORMANCE } from "./conformance/um-conformance.mjs";
// BEGIN — v0.4 UM manifest emitter (new web/manifest/ module). Emitting a
// schema-valid, signed v0.4 manifest at crossing time for the UM panel. This flips NO
// um_conformance flag (schema-valid ≠ evaluator-conformant; that is /117b) and does
// not touch the existing um_shaped_envelope. Import is best-effort; a failure here must
// never break the demo (wrapped where used).
import {
  buildAndSignManifest as umBuildAndSignManifest,
  verifyManifestSignature as umVerifyManifestSignature,
} from "./manifest/um-manifest-emitter.mjs";
import { makeAvatarDefinition as umMakeAvatarDefinition, makeLoadingPointer as umMakeLoadingPointer } from "./manifest/interfaces.mjs";
// BEGIN — loading-content THROUGH the portal (portaling bar P11;
// interface requirement; demonstration-only). The destination's branded loading experience
// renders in the SOURCE while the crossing's real background steps check-mark
// (Scene 3b). Content = the destination server's metaverse.portal.* pointers
//bound into the emitted v0.4 manifest via
// LoadingPointer seam. Flips NO conformance flag.
import {
  initPortalLoadingOverlay as featureInitPortalLoadingOverlay,
  notePortalLoadingState as featureNotePortalLoadingState,
  buildLoadingPointersForManifest as featureBuildLoadingPointersForManifest,
  extractPortalLoadingContent as featureExtractPortalLoadingContent,
  portalLoadingDriverApi as featurePortalLoadingDriverApi,
} from "./portal-loading.mjs";
// END
// END
// inventory slot catalog + the schema/resolve helpers
// the slot-swap path reuses (same module instance live-adapter.js imports).
import {
  inventorySlots,
  equipmentCatalog,
  validateEquippedItems,
  resolveEquipmentItems,
} from "./equipment-view.js";
import { Scene } from "./vendor/scene-core/scene.js";
import { mountCanonicalWorldContent } from "./vendor/scene-core/canonical-world-content.js";
import {
  FRONTEND_CONTRACT,
  HANDOFF_PHASES,
  PROVENANCE,
} from "./vendor/scene-core/frontend-contract.js";
import * as THREE from "three";
// the WoW CORE REQUIREMENTS (join/follow/preview/persist/share) are
// plain URL + hash-fragment semantics, not an API. web/wow-url.mjs is the pure grammar.
import { parseWorldUrl } from "./wow-url.mjs";
// one hardcoded same-origin proxy base ("/api/b") is built here rather than
// through the LiveAdapter ENDPOINTS chokepoint; route it through the ONE base-path helper too so
// the player's server-B aperture preview resolves beneath the public prefix. Root mode: identity.
import { apiBase } from "./base-path.mjs";
import { reconcileKeyedHtml } from "./reconcile-keyed-html.mjs";
import { NO_EQUIPMENT_CHOICE, applyNoEquipmentChoice } from "./no-equipment-choice.mjs";
import { createPlayerSessionController } from "./player-session-controller.mjs";
import { createNotificationToastController } from "./notification-toast-controller.mjs";
import { createPortalRenderController } from "./portal-render-controller.mjs";
import { createAvatarSelectorController } from "./avatar-selector-controller.mjs";
import { createAirportStorefrontInteractionController } from "./airport-storefront-interaction-controller.mjs";
import { createAirportBoardingJourneyController } from "./airport-boarding-journey-controller.mjs";
import {
  assertPanelTruthChromeControllerContract,
  createPanelTruthChromeController,
} from "./panel-truth-chrome-controller.mjs";
import { createSceneRuntimeController } from "./scene-runtime-controller.mjs";
// P3: pure client-identity + exit-parity helpers. SAME
// specifier as scene-runtime-controller.mjs so the browser reuses the one
// loaded module instance (a bare "./portal-spatial-preview.mjs" would
// double-execute the module under a second cache key).
// P4: + the deterministic perimeter live-vs-image gate and
// the viewer-side classifier (render half).
import {
  expectedPortalEdgeId,
  imageLayerFlipForViewerSide,
  portalPerimeterLiveGate,
  portalSharedEdgeIdentity,
  portalViewerSide,
} from "./portal-spatial-preview.mjs?v=meeting-critical-destination";
import { portalLocalCoordinates } from "./live-adapter-portal-geometry.mjs";
import {
  createMovementCameraController,
  reframeCrossingCameraMapping,
} from "./movement-camera-controller.mjs";
import { createMotionPreference } from "./motion-preference.mjs";
import { pixelRatioFor, renderQualityLevers } from "./render-quality-levers.mjs";
import { createSemanticDestinationsController } from "./semantic-destinations-controller.mjs";
import { mountDemoTrajectoryTool } from "./demo-trajectory/trajectory-panel.mjs?v=runtime";
import {
  createRunTweakRegistry,
  createRuntimeTweakController,
} from "./runtime-tweak-controller.mjs";

const params = new URLSearchParams(location.search);
const portalAtomicityOracleParam = ["127.0.0.1", "localhost"].includes(location.hostname) &&
  ["microtask", "task", "raf", "all"].includes(params.get("portal_atomicity_oracle"))
  ? params.get("portal_atomicity_oracle")
  : null;
const cameraWallFaultArms = new Set(["disabled", "avatar_xray", "non_restoration", "wrong_wall"]);
let cameraWallFault = cameraWallFaultArms.has(params.get("camera_wall_fault"))
  ? params.get("camera_wall_fault")
  : null;
const motionPreference = createMotionPreference({ view: window, target: document.documentElement });
const launcherMissionParam = params.get("mission");
// read the world + intent out of the URL ONCE at boot. Read-only: the
// no-reload guard forbids writing location/history (Puppeteer counts pushState as a
// framenavigated), and the Core Requirements never need us to write — the URL is the input.
//   bare URL / #join[=aspect] -> join    (presence REGISTERED)
//   #follow[=aspect]          -> follow  (presence REGISTERED + viewpoint target)
//   #preview[=aspect]         -> preview (presence NOT registered — see wow-url.mjs I5)
// FAIL-SAFE: this runs at module top level, so a throw here would take the WHOLE app down.
// A malformed/exotic href must degrade to "no WoW intent" (which the adapter treats exactly as
// pre-064 behavior: join, presence registered), never to a blank page.
function readWowUrlIntent() {
  try {
    return parseWorldUrl(location.href);
  } catch (err) {
    console.warn("[wow-url] could not parse world URL; falling back to default join", err);
    return null;
  }
}
const wowUrlIntent = readWowUrlIntent();
// A `/w/{world}` URL is a WoW WORLD URL (the spec's path-composable form, served by
// src/serve.js). Unlike the legacy ?role=source|target inspector views, it is a world ENTRY,
// so it boots the embodied player role. See interpretation I10 in the result.
const isWowWorldUrl = !!wowUrlIntent && wowUrlIntent.worldSource === "path";
// explicit stage entry. Stage mode defaults to the
// consumer/player role and the distance-readable truth panel; ordinary URLs
// retain their historical role default and inspector presentation.
const stageParam = params.get("stage") === "1" || params.get("stage") === "true";
const roleParam = params.get("role");
const role = roleParam === "target"
  ? "target"
  : roleParam === "player" || (!roleParam && (stageParam || isWowWorldUrl))
    ? "player"
    : "source";
const isPlayer = role === "player";
// a `/w/{world}` WoW world URL selects its own world (an explicit
// ?active= still wins). Legacy URLs are untouched: absent both, this is "" exactly as before.
const activeParam = params.get("active") || (isWowWorldUrl ? wowUrlIntent.world : "");
// R1.1 — URL-driven root fabric entry. When present, this
// absolute-or-relative URL is the ROOT fabric the browser loads (an OMB `.msf`
// compact-JWS token for M1), replacing the frozen ENDPOINTS/role lookup. Absent
// => behavior is exactly today's. No URL/history mutation (no-reload
// guard): the value is read once at boot from location.search and never written.
const fabricParam = null;
// URL/id-driven WoW world entry. When present,
// this opens a WoW world by its Spatial Composition Graph (a dev-fixture bundle
// URL/path now; a live spatialID against /wow/spatial/{id} once serves
// it) and renders it through buildWowScene — the browser OMB "open a WoW world
// by URL -> load -> render" entry (PROP §2 #1). Additive: absent => today's
// behavior. Read once at boot.
const wowParam = params.get("wow");
// the meeting-visible default is the clean base avatar.
// An explicit `?noequip=0` remains available to focused legacy equipment proofs.
const noEquipParam = params.get("noequip") !== "0" && params.get("noequip") !== "false";
// additive faithful-render switch for the `.msf`
// path. When `?faithful=1` accompanies `?fabric=<url.msf>`, mainMsfRead runs the
// fabric's REAL hash-verified `map.wasm` via the Scene ABI host and renders the
// authoritative baked scene at PHYSICAL orbital scale with the real celestial
// textures (buildFaithfulSolarScene), instead of the M1 log-radial static
// preview (buildMsfScene). `?view=oracle|overview` picks the camera; `?epoch=<n>`
// overrides the default epoch (0). Absent => today's behavior is unchanged.
const faithfulParam = params.get("faithful") === "1" || params.get("faithful") === "true";
const faithfulView = params.get("view") === "oracle" ? "oracle" : "overview";
const faithfulEpoch = params.get("epoch");

// manual-reload location persistence for the PLAYER
// view. When the player refreshes the browser, the view must resume at the
// CURRENT server/location and CURRENT pose — not reset to the original world's
// spawn. State is carried entirely in sessionStorage (a single, purely
// CLIENT-side channel); NO server change is made and — critically — the URL and
// browser history are NEVER touched. (Puppeteer/Playwright count
// history.pushState/replaceState as a main-frame `framenavigated`, so writing
// the fabric into the URL would have broken the no-reload proof's
// nav-count==1 guard. sessionStorage writes fire no navigation.)
//
// On a genuine browser RELOAD the saved fabric key is read BEFORE the adapter is
// constructed and fed in as the `active` override, so endpointKeyForRole() binds
// the adapter to the world the player was standing in (world B after a crossing
// into B); the saved pose/orbit framing are then applied via
// adapter.applyRestoredPose so the refresh lands at the exact spot, not just the
// right world. Restore fires ONLY on navigation type "reload" with a saved
// record — the e2e's fresh loads (type "navigate", empty sessionStorage) never
// restore, so they boot `active=source` → world A exactly as before, and the
// seamless crossing (no reload, in-memory marker intact) is untouched.
// The Phase 1 map mentioned replaceState, but that planning language is stale:
// the accepted contract is sessionStorage-only and performs no URL/history write.
const playerSessionController = createPlayerSessionController({
  getStorage: () => (typeof sessionStorage !== "undefined" ? sessionStorage : null),
  readNavigationEntries: () =>
    typeof performance !== "undefined" && performance.getEntriesByType
      ? performance.getEntriesByType("navigation")
      : [],
  elapsedNow: () =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now(),
  savedAtNow: () => new Date().toISOString(),
});

// The active endpoint key to boot into. On a genuine RELOAD carrying a saved
// record, resume that fabric; otherwise honour the URL `active` param unchanged.
// This is the ONLY place the persisted fabric influences which world loads, and
// it does so without any URL/history mutation.
function resolveBootActive() {
  return playerSessionController.resolveBootActive({ isPlayer, activeParam });
}

// Persist the player's CURRENT location + pose so a manual reload can restore
// it. sessionStorage only — no URL/history write. Safe to call every frame — it
// self-throttles unless force=true.
function persistPlayerLocationState(force = false) {
  if (!isPlayer || !adapter) return;
  try {
    playerSessionController.persist({
      isPlayer,
      force,
      getSnapshot: () => {
        const visual = adapterVisualRuntimeSnapshot();
        const av = visual?.state?.avatar || null;
        const debug = adapterVisualDebugState();
        const cameraState = movementCameraController
          ? movementCameraController.sessionCameraSnapshot()
          : null;
        return {
          activeEndpointKey: visual?.activeEndpointKey || adapter.activeEndpointKey,
          activeParam,
          locationId: debug && debug.location_id ? debug.location_id : null,
          position: av && Array.isArray(av.position) ? av.position : null,
          rotationY: av ? av.rotation_y : undefined,
          orbitAzimuthRad: cameraState ? cameraState.orbitAzimuthRad : undefined,
          orbitPolarRad: cameraState ? cameraState.orbitPolarRad : undefined,
          orbitDistanceM: cameraState ? cameraState.orbitDistanceM : undefined,
          cameraMode: cameraState ? cameraState.cameraMode : undefined,
        };
      },
    });
  } catch (e) {
    /* runtime snapshots and session persistence are best-effort */
  }
}

// Read a previously-persisted player session for POSE restore, but ONLY when
// this load is a genuine browser RELOAD and the saved fabric matches the fabric
// this page actually booted into (they agree because resolveBootActive() booted
// from the same record). Returns null otherwise (first load / fresh navigation /
// mismatch / no data), which keeps the e2e's fresh loads on their spawn.
function readRestorablePlayerSession() {
  return playerSessionController.readRestorable({
    isPlayer,
    activeEndpointKey: adapter ? adapter.activeEndpointKey : activeParam,
  });
}

// display-only labels for the observer role chip. `role`
// itself stays "source"/"target"/"player" for all logic, endpoint binding,
// spawn/colour, and handoff correlation — only the on-screen text changes.
const ROLE_DISPLAY_LABEL = {
  source: "SERVER A",
  target: "SERVER B",
  player: "PLAYER",
};

const $ = (id) => document.getElementById(id);
const appEl = $("app");
const rootListenerRemovers = [];
let applicationDisposed = false;
let panelTruthChromeController = null;

function listenAtRoot(target, type, listener, options) {
  if (!target || typeof target.addEventListener !== "function") return;
  target.addEventListener(type, listener, options);
  rootListenerRemovers.push(() => target.removeEventListener(type, listener, options));
}

const CONNECTION_STATE_PRESENTATION = Object.freeze({
  loading: { label: "Loading", footer: "connecting to components 3 backend" },
  live: { label: "Live backend", footer: "real components 3 backend" },
  disconnected: { label: "Disconnected", footer: "components 3 backend unavailable" },
  unavailable: { label: "Temporarily unavailable", footer: "runtime temporarily unavailable" },
  refused: { label: "Runtime refused", footer: "trust or policy refusal" },
  error: { label: "Connection error", footer: "components 3 backend returned an error" },
});
let connectionPresentation = {
  state: "loading",
  detail: "Connecting to the live world…",
};
let playerOrientationDismissed = false;
// the crossing is a CONTINUOUS walk-through — the old
// portal_centering/portal_spin/portal_disappear beats are deleted; the single
// remaining transition phase marks the commit-in-flight frames.
const PORTAL_TRANSITION_PHASES = Object.freeze({
  WALKTHROUGH: "portal_walkthrough",
});
// World Navigator: the child fabric (world B) is composed into the SAME
// Three.js scene (one context / one SOM) but on its own render layer, so the
// main camera never draws it directly — only the aperture render-to-texture
// camera (layers.set) sees it. That render replaces static placeholder.
const CHILD_FABRIC_LAYER = 2;

function hexColorFromFabricBackground(background, fallback = 0x0b1020) {
  if (typeof background !== "string" || !/^[0-9a-fA-F]{6}$/.test(background)) return fallback;
  return parseInt(background, 16);
}

function setLayerRecursive(object3d, layer) {
  object3d.layers.set(layer);
  object3d.traverse((child) => child.layers.set(layer));
}

/**
 * THE POST-CROSSING OPAQUE PANEL.
 *
 * The standing oval's APERTURE is a window, and a window can only be looked
 * THROUGH from the side you are on. Its fill is `THREE.DoubleSide` at every
 * rung of the preview ladder — the base fill (below), the labeled/region canvas
 * material (ensurePortalPreviewTexture), the child-fabric render texture, and
 * screen-space projective ShaderMaterial
 * (portal-spatial-preview.mjs:161) — and every one of those rungs is opaque or
 * near-opaque (0.96 / transparent:false). NOTHING suppressed the fill when the
 * camera ended up on the far side of the portal plane.
 *
 * A crossing delivers the avatar AT the destination portal plane, so the
 * third-person camera lands ~2.5 m BEHIND that plane and looks through it at
 * the avatar. A 1.76 x 2.74 m ellipse at 2.5 m subtends the entire viewport.
 * MEASURED at the first frame after commit: `standing-oval-
 * aperture` was the FIRST OCCLUDER at the viewport centre — 100% of the centre
 * region, 56.7% of the whole frame, DoubleSide, opacity 0.96, textured. That is
 * the flat panel, and it "clears once you walk far enough away" purely
 * because the ellipse shrinks below the frame.
 *
 * Unlike opaque world geometry, this DoubleSide portal fill is a view surface
 * and cannot rely on depth testing to disappear when viewed from its back.
 * `separates` is the plane test; the raycast is the extent test (so a portal
 * across the room whose infinite plane happens to separate camera and avatar
 * does NOT blank — only one actually in the way does).
 *
 * WHY THIS CANNOT REGRESS WHAT IS PROTECTED:
 *   - The WINDOW: while you look THROUGH the portal, the camera and
 *     the avatar are on the SAME side of its plane, so `separates` is false and
 *     the aperture is untouched. The window, its glue and its 0.000000 NDC ring
 *     alignment are not in this code path at all.
 *   - ONE-WAY blocked-side opacity: a player who has NOT crossed and
 *     walks up to a blocked side has their camera and avatar BOTH on the
 *     blocked side — same side, `separates` false — so the opaque panel stays
 *     opaque for them. It is suppressed only for someone it is standing behind,
 *     i.e. someone who HAS come through.
 *   - FIRST PERSON: the camera IS the avatar, so nothing can be between them.
 *     The gate restores and returns inactive.
 */
/** The portal fill surfaces this gate owns. `portalSurfaceWanted` is the
 *  visibility the rest of the app asked for; the gate may only SUBTRACT from
 *  it, never add — so it can never resurrect a panel someone else hid. */
function portalApertureOcclusionCandidates(impl) {
  const out = [];
  const push = (mesh) => {
    if (mesh && mesh.isMesh && mesh.userData && "portalSurfaceWanted" in mesh.userData) out.push(mesh);
  };
  push(impl.directionalPortalAperture);
  push(impl.directionalPortalBlockedPanel);
  if (impl.additionalPortalGroups) {
    for (const key of Object.keys(impl.additionalPortalGroups)) {
      const rec = impl.additionalPortalGroups[key];
      if (!rec) continue;
      push(rec.aperture);
      push(rec.blockedPanel);
    }
  }
  return out;
}

function roomWallOcclusionCandidates(impl) {
  if (!impl || !impl.scene || !impl.camera) return [];
  return impl.scene.children.filter((mesh) => {
    const geometry = mesh && mesh.geometry;
    const parameters = geometry && geometry.parameters;
    return !!(
      mesh &&
      mesh.isMesh &&
      geometry &&
      geometry.type === "PlaneGeometry" &&
      Number(parameters && parameters.width) === 12 &&
      Number(parameters && parameters.height) === 5 &&
      mesh.layers.test(impl.camera.layers)
    );
  });
}

function updatePortalApertureOcclusion(position, target, cameraMode) {
  const impl = scene && scene._impl;
  const candidates = impl ? portalApertureOcclusionCandidates(impl) : [];
  const wallCandidates = impl ? roomWallOcclusionCandidates(impl) : [];
  return movementCameraController
    ? movementCameraController.updatePortalOcclusion(position, target, cameraMode, {
        impl,
        candidates,
        wallCandidates,
        sceneId: impl && impl.scene ? impl.scene.uuid : null,
        worldId: adapter && adapter.world ? adapter.world.location_id : null,
        faultArm: cameraWallFault,
      })
    : null;
}

function makeFabricLabelSprite(lines, accentCss) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(8, 12, 26, 0.78)";
  ctx.strokeStyle = accentCss;
  ctx.lineWidth = 10;
  ctx.roundRect(10, 10, canvas.width - 20, canvas.height - 20, 30);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 64px ui-monospace, Menlo, monospace";
  ctx.fillText(String(lines[0] || ""), canvas.width / 2, 86);
  ctx.font = "38px ui-monospace, Menlo, monospace";
  ctx.fillStyle = accentCss;
  ctx.fillText(String(lines[1] || ""), canvas.width / 2, 172);
  const texture = new THREE.CanvasTexture(canvas);
  if ("SRGBColorSpace" in THREE) texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
  );
  sprite.scale.set(2.6, 0.65, 1);
  return sprite;
}

/**
 * Build a Three.js rendition of a CHILD fabric manifest (the "other side" of
 * the portal): floor/room dressing from `primary.background` + accent palette,
 * then presentation for fabric `data` nodes — the return-portal attachment
 * node (bSubtype 255) as a standing oval and the spawn node as a pad marker.
 * `action:` bounds remain logical manifest data and are intentionally not
 * rendered. Everything is placed at the node's own Transform (child-local
 * coordinates; the attachment offset is identity because both worlds put
 * their portal node at the same local position). Lights are included in-group
 * because the aperture camera only renders this layer.
 */
function buildChildFabricGroup(manifest, opts = {}) {
  const accent = opts.accent ?? 0xff7a3a;
  const accentFill = opts.accentFill ?? 0xffb14d;
  const group = new THREE.Group();
  group.name = `fabric-child-${(manifest && manifest.container) || "unknown"}`;
  group.userData.fabric = {
    container: manifest && manifest.container,
    url: opts.url || null,
    attached_at_portal_node: opts.attachedAtNodeId || null,
    unsigned_plain_json: true,
  };

  const roomColor = new THREE.Color(accent).multiplyScalar(0.35);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshStandardMaterial({ color: roomColor, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.name = "child-fabric-floor";
  group.add(floor);
  const grid = new THREE.GridHelper(12, 12, 0xffffff, 0xd88f5a);
  grid.material.opacity = 0.3;
  grid.material.transparent = true;
  group.add(grid);
  const wallMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent).multiplyScalar(0.55),
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), wallMat);
  backWall.position.set(0, 2.5, -6);
  group.add(backWall);
  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), wallMat);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-6, 2.5, 0);
  group.add(leftWall);

  group.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(4, 8, 6);
  group.add(key);

  const nodes =
    manifest && manifest.data && Array.isArray(manifest.data.Children) ? manifest.data.Children : [];
  for (const node of nodes) {
    if (!node) continue;
    const p = node.Transform && Array.isArray(node.Transform.Position)
      ? node.Transform.Position
      : [0, 0, 0];
    const px = Number(p[0]) || 0;
    const pz = Number(p[2]) || 0;
    const isPortalNode = node.Type && Number(node.Type.bSubtype) === 255;
    const ref = node.Resource && typeof node.Resource.sReference === "string" ? node.Resource.sReference : "";
    if (isPortalNode) {
      const portal = new THREE.Group();
      portal.name = `child-fabric-node-${(node.Head && node.Head.Self) || "portal"}`;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.075, 18, 80),
        new THREE.MeshStandardMaterial({
          color: accent,
          emissive: accent,
          emissiveIntensity: 0.7,
          roughness: 0.35,
          metalness: 0.25,
        })
      );
      portal.add(ring);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.92, 72),
        new THREE.MeshBasicMaterial({ color: accentFill, transparent: true, opacity: 0.2, side: THREE.DoubleSide })
      );
      portal.add(disc);
      portal.position.set(px, 1.35, pz);
      // stand the oval facing back into this child world's room (toward its spawn)
      portal.rotation.y = opts.portalYaw ?? 0;
      portal.scale.set(0.9, 1.4, 1);
      portal.visible = opts.suppressReturnPortal !== true;
      portal.userData.secondaryRingSuppressed = opts.suppressReturnPortal === true;
      group.add(portal);
    } else if (ref.startsWith("action:")) {
      continue;
    } else if (node.Transform) {
      const pad = new THREE.Group();
      pad.name = `child-fabric-node-${(node.Head && node.Head.Self) || "spawn"}`;
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, 0.06, 40),
        new THREE.MeshStandardMaterial({ color: accentFill, emissive: accent, emissiveIntensity: 0.35 })
      );
      disc.position.y = 0.03;
      pad.add(disc);
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 1.5, 10),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })
      );
      post.position.y = 0.78;
      pad.add(post);
      pad.position.set(px, 0, pz);
      group.add(pad);
    }
  }

  const label = makeFabricLabelSprite(
    [
      String((manifest && manifest.container) || "child fabric").toUpperCase(),
      "child fabric · plain-JSON (unsigned)",
    ],
    opts.accentCss || "#ffb14d"
  );
  label.position.set(
    opts.labelPosition ? opts.labelPosition[0] : 0.8,
    2.35,
    opts.labelPosition ? opts.labelPosition[2] : -2.8
  );
  label.name = "child-fabric-container-label";
  group.add(label);

  setLayerRecursive(group, CHILD_FABRIC_LAYER);
  return group;
}

/**
 * The root fabric's `action:` bounds stay in navigator/debug state for trigger
 * evaluation but have no user-facing geometry. Remove stale helpers here so
 * a scene composed by older code cannot retain or resurrect the cage.
 *
 * the blue floor "spawn disc" (the cyan cylinder pad
 * that used to mark navigator.root_spawn_node) is REMOVED. The player already
 * spawns at the root fabric's own primary.camera pose — a specific defined room
 * position (see live-adapter _initWorldNavigator / applyRestoredPose) — not on a
 * disc, so no floor marker is drawn. The `root_spawn_node` DATA still rides in
 * the navigator debug for provenance; only its visual pad is gone.
 */
function buildRootFabricNodeVisuals(impl, navigatorDebug) {
  if (!impl || !impl.scene || !navigatorDebug) return null;
  const stale = [];
  impl.scene.traverse((node) => {
    if (node?.name === "fabric-root-portal-trigger-node") stale.push(node);
  });
  for (const node of stale) {
    node.parent?.remove(node);
    node.geometry?.dispose?.();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach((material) => material?.dispose?.());
  }
  if (impl.rootFabricNodesGroup?.parent) impl.rootFabricNodesGroup.parent.remove(impl.rootFabricNodesGroup);
  impl.rootFabricNodesGroup = null;
  return null;
}

function recordPanelActivity(input) {
  // Startup and disposal are legitimate controller-absent phases. Once a
  // controller exists, a missing method is a contract defect and must fail
  // explicitly instead of being hidden by optional chaining.
  if (panelTruthChromeController == null) return null;
  return assertPanelTruthChromeControllerContract(panelTruthChromeController).recordActivity(input);
}

function logLine(msg) {
  recordPanelActivity({ message: String(msg), eventClass: "runtime" });
  console.log(`[assembly:${role}] ${msg}`);
}

// transient auto-dismissing toasts for the "Crossing"/
// "Departed" and "Arrival received" EVENT notices, in place of the former
// persistent state-card use for those two phases (all three views). Wording
// is unchanged — only the presentation (temporary toast vs. persistent card)
// and dismiss timing are new. Steady-state overlay text (idle/portal-active/
// centering/holding-pose/waiting) is untouched and keeps using
// #state-overlay/.state-card.
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

const notificationToastController = createNotificationToastController({
  lookup: $,
  createElement: (tagName) => document.createElement(tagName),
  body: document.body,
  eventTarget: window,
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  formatTime: (raw) => {
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour12: false }) : String(raw);
  },
  setTimer: (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: (timer) => window.clearTimeout(timer),
  escapeHtml,
  isTypingTarget,
  motionPreference,
  logger: logLine,
});

function showToast(big, sub, cls, opts = {}) {
  notificationToastController.show(big, sub, cls, opts);
}

function applyStageScenePresentation(root) {
  return sceneRuntimeController ? sceneRuntimeController.hideStageDebugVisuals(root) : 0;
}

// notification producers stay in the composition root;
// the bounded store, history/detail UI, selection, and transient toast
// lifecycle are owned by the mounted notification/toast controller.
const publishedFabricEventKeys = new Set();

function latestNotificationIdByKind(kind) {
  return notificationToastController.latestByKind(kind);
}

function publishNotificationRecord(record) {
  notificationToastController.publish(record);
}

function openNotificationCenter(id) {
  notificationToastController.open(id);
}

function closeNotificationCenter() {
  notificationToastController.close();
}

function wireNotificationCenter() {
  notificationToastController.mount();
}

function fabricEventRecordId(event, index, portalKey) {
  const eventName = event && event.event ? String(event.event) : "fabric_event";
  const at = event && event.at ? String(event.at) : String(index);
  // the portal key disambiguates same-tick events from
  // different machines (two lobby zones entered on the same sample).
  const scope = portalKey ? `-${portalKey}` : "";
  return `fabric-prefetch${scope}-${eventName}-${at}`.replace(/[^a-zA-Z0-9_.:-]+/g, "-");
}

function publishFabricPrefetchNotifications(fp) {
  if (!fp || !fp.supported || !Array.isArray(fp.events)) return;
  for (let i = 0; i < fp.events.length; i += 1) {
    const event = fp.events[i];
    if (!event || !event.event) continue;
    const id = fabricEventRecordId(event, i, fp.portal_key || null);
    if (publishedFabricEventKeys.has(id)) continue;
    publishedFabricEventKeys.add(id);
    const totals = fp.region && fp.region.totals ? fp.region.totals : null;
    const occupancy = fp.presence && fp.presence.occupancy ? fp.presence.occupancy : null;
    const destination = fp.address
      ? {
          location_id: fp.address.location_id,
          world_id: fp.address.world_id,
          fabric_id: fp.address.fabric_id,
          authority: fp.address.authority,
        }
      : null;
    const record = {
      id,
      kind: "fabric_prefetch_event",
      event_type: event.event,
      status: fp.status || "unknown",
      title: event.event.replace(/_/g, " "),
      summary: [
        fp.address ? fp.address.location_id : null,
        event.region_entities != null && event.fabric_entities != null
          ? `${event.region_entities}/${event.fabric_entities} entities`
          : null,
        event.occupancy_count != null ? `${event.occupancy_count} present` : null,
      ].filter(Boolean).join(" · "),
      created_at: event.at || new Date().toISOString(),
      updated_at: event.at || new Date().toISOString(),
      source: {
        location_id: adapter && adapter.active ? adapter.active.location_id : null,
        world_id: adapter && adapter.active ? adapter.active.world_id : null,
        endpoint_key: adapter && adapter.active ? adapter.active.endpoint_key : null,
      },
      destination,
      prefetch: {
        status: fp.status,
        address: fp.address || null,
        zone: fp.zone || null,
        zones: fp.zones || null,
      },
      region: fp.region
        ? {
            loaded_at: fp.region.loaded_at || null,
            age_ms: fp.region.age_ms ?? null,
            totals,
          }
        : null,
      occupancy,
      claim_boundary: {
        application_level: true,
        roi_standard_conformance: false,
        standards_conformance: false,
      },
      raw_event: event,
    };
    publishNotificationRecord(record);
  }
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName ? target.tagName.toLowerCase() : "";
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function fixed3(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(3) : "—";
}

function vec3Label(value) {
  return Array.isArray(value) ? value.slice(0, 3).map(fixed3).join(", ") : "—";
}

// the stable per-portal key (server string id when the
// descriptor carried one, else the numeric resource id stringified) — must
// match the adapter's fabricPortalKey so keyed prefetch machines line up.
function appPortalKey(entry) {
  if (!entry) return null;
  if (typeof entry.string_portal_id === "string" && entry.string_portal_id) {
    return entry.string_portal_id;
  }
  return entry.portal_id != null ? String(entry.portal_id) : null;
}

function alignPortalVisualToTrigger(sceneInstance, world) {
  const portal = world && world.portal;
  const frame = portal && portal.frame;
  const trigger = portal && portal.trigger;
  const center = frame && Array.isArray(frame.position)
    ? frame.position.slice(0, 3)
    : trigger && Array.isArray(trigger.position)
      ? trigger.position.slice(0, 3)
      : null;
  const radius = trigger ? Number(trigger.radius_m || 0) : 0;
  if (!sceneInstance || !center || !frame) {
    return { aligned: false, reason: "missing_scene_or_portal_frame" };
  }
  const impl = sceneInstance._impl;
  if (!impl || !impl.scene) {
    return {
      aligned: false,
      renderer_kind: sceneInstance.rendererKind,
      trigger_center: center,
      radius_m: radius,
      frame,
      reason: "portal_visual_not_addressable",
    };
  }
  if (sceneInstance.rendererKind !== "webgl" || !impl.scene) {
    return {
      aligned: false,
      renderer_kind: sceneInstance.rendererKind,
      trigger_center: center,
      radius_m: radius,
      frame,
      reason: "standing_oval_requires_webgl_scene_access",
    };
  }
  if (impl.portalGroup) impl.portalGroup.visible = false;
  const sourceColored = !world || world.location_id !== "location-b";
  const color = sourceColored ? 0x66e0ff : 0xffc266;
  const fillColor = sourceColored ? 0x2bd4ff : 0xffb14d;
  if (!impl.directionalPortalGroup) {
    impl.directionalPortalGroup = new THREE.Group();
    impl.directionalPortalGroup.name = "directional-standing-oval-portal";
    const ringMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.72,
      roughness: 0.32,
      metalness: 0.24,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.075, 18, 80), ringMat);
    ring.name = "standing-oval-ring";
    impl.directionalPortalGroup.add(ring);
    const apertureMat = new THREE.MeshBasicMaterial({
      color: fillColor,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
    });
    const aperture = new THREE.Mesh(new THREE.CircleGeometry(0.92, 72), apertureMat);
    aperture.name = "standing-oval-aperture";
    // the aperture fill is always WANTED; only the
    // camera/player occlusion gate may subtract it (see
    // updatePortalApertureOcclusion).
    aperture.userData.portalSurfaceWanted = true;
    impl.directionalPortalGroup.add(aperture);
    impl.directionalPortalAperture = aperture;
    const horizon = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.62, 0, 0.01),
        new THREE.Vector3(0.62, 0, 0.01),
      ]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
    );
    horizon.name = "portal-frame-right-axis";
    impl.directionalPortalGroup.add(horizon);
    impl.scene.add(impl.directionalPortalGroup);
  }
  // the direction ArrowHelper ("portal-forward-debug-arrow")
  // is REMOVED after review — direction is now expressed by the portal
  // data itself (traversal rule) and, for one-way portals, by the opaque
  // blocked side below. A stale arrow from a pre-removal scene graph is
  // dropped defensively so recomposed scenes can never resurrect it.
  if (impl.directionalPortalArrow) {
    if (impl.scene && typeof impl.scene.remove === "function") {
      impl.scene.remove(impl.directionalPortalArrow);
    }
    impl.directionalPortalArrow = null;
  }
  if (!impl.directionalPortalAperture && impl.directionalPortalGroup && typeof impl.directionalPortalGroup.getObjectByName === "function") {
    impl.directionalPortalAperture = impl.directionalPortalGroup.getObjectByName("standing-oval-aperture");
  }
  // the blocked side of a one-way portal is VISIBLY
  // OPAQUE. A separate single-sided disc renders only toward the blocked
  // half-space (CircleGeometry normals face local +Z = frame "front", so
  // BackSide shows the disc only to viewers on the "back" half-space and
  // FrontSide only to the "front"), while the allowed side keeps the normal
  // translucent aperture + preview ladder untouched. Hidden entirely on
  // bidirectional portals.
  if (!impl.directionalPortalBlockedPanel && impl.directionalPortalGroup) {
    const blockedPanel = new THREE.Mesh(
      new THREE.CircleGeometry(0.98, 72),
      new THREE.MeshBasicMaterial({ color: 0x11162a, side: THREE.BackSide })
    );
    blockedPanel.name = "standing-oval-aperture-blocked-side";
    blockedPanel.visible = false;
    impl.directionalPortalGroup.add(blockedPanel);
    impl.directionalPortalBlockedPanel = blockedPanel;
  }
  const traversal = portal && portal.traversal ? portal.traversal : null;
  const oneWay = !!(traversal && traversal.mode === "one_way");
  const blockedSide = oneWay ? traversal.blocked_entry_side || "back" : null;
  if (impl.directionalPortalBlockedPanel) {
    impl.directionalPortalBlockedPanel.visible = oneWay;
    // blocked panel is WANTED exactly when the
    // portal is one-way. The occlusion gate may only subtract it — and it only
    // does so for a camera it is standing BETWEEN and the player, i.e. for
    // someone who has already come through. A player who has NOT crossed sees
    // it from the same side as their own avatar, so it stays opaque for them.
    impl.directionalPortalBlockedPanel.userData.portalSurfaceWanted = oneWay;
    if (oneWay) {
      impl.directionalPortalBlockedPanel.position.z = blockedSide === "front" ? 0.02 : -0.02;
      impl.directionalPortalBlockedPanel.material.side =
        blockedSide === "front" ? THREE.FrontSide : THREE.BackSide;
    }
  }
  const forward = Array.isArray(frame.forward) ? frame.forward : [0, 0, 1];
  const yaw = Math.atan2(Number(forward[0]) || 0, Number(forward[2]) || 0);
  impl.directionalPortalGroup.visible = true;
  impl.directionalPortalGroup.position.set(center[0], center[1], center[2]);
  impl.directionalPortalGroup.rotation.set(0, yaw, 0);
  impl.directionalPortalGroup.scale.set(
    Math.max(0.001, Number(frame.width_m || 1.8) / 2),
    Math.max(0.001, Number(frame.height_m || 2.8) / 2),
    1
  );
  if (typeof impl.directionalPortalGroup.updateMatrixWorld === "function") impl.directionalPortalGroup.updateMatrixWorld(true);
  const visualCenter = [
    Number(impl.directionalPortalGroup.position.x.toFixed(3)),
    Number(impl.directionalPortalGroup.position.y.toFixed(3)),
    Number(impl.directionalPortalGroup.position.z.toFixed(3)),
  ];
  const aligned =
    Math.abs(visualCenter[0] - Number(center[0] || 0)) <= 0.002 &&
    Math.abs(visualCenter[1] - Number(center[1] || 0)) <= 0.002 &&
    Math.abs(visualCenter[2] - Number(center[2] || 0)) <= 0.002;
  // ADDITIONAL portals (N>1 worlds — the lobby). The
  // PRIMARY portal above keeps its exact pre-004 node names and impl
  // singletons (single-portal worlds are byte-identical); every additional
  // portal gets its own standing-oval group — same ring/aperture/blocked-side
  // recipe, node names suffixed with the portal key, tinted by DESTINATION
  // (A = cyan, B = amber). Stale groups are pruned when the world changes.
  const portalList =
    world && Array.isArray(world.portals) && world.portals.length ? world.portals : [portal];
  if (!impl.additionalPortalGroups) impl.additionalPortalGroups = {};
  const wantedKeys = new Set();
  const additionalPortals = [];
  for (let index = 1; index < portalList.length; index += 1) {
    const entry = portalList[index];
    const entryKey = appPortalKey(entry);
    const entryFrame = entry && entry.frame;
    if (!entry || !entryFrame || !entryKey) continue;
    wantedKeys.add(entryKey);
    let rec = impl.additionalPortalGroups[entryKey];
    const destIsB = String(entry.target_location_id || "") === "location-b";
    const entryColor = destIsB ? 0xffc266 : 0x66e0ff;
    const entryFill = destIsB ? 0xffb14d : 0x2bd4ff;
    if (!rec) {
      const group = new THREE.Group();
      group.name = `directional-standing-oval-portal--${entryKey}`;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.075, 18, 80),
        new THREE.MeshStandardMaterial({
          color: entryColor,
          emissive: entryColor,
          emissiveIntensity: 0.72,
          roughness: 0.32,
          metalness: 0.24,
        })
      );
      ring.name = `standing-oval-ring--${entryKey}`;
      group.add(ring);
      const aperture = new THREE.Mesh(
        new THREE.CircleGeometry(0.92, 72),
        new THREE.MeshBasicMaterial({
          color: entryFill,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide,
        })
      );
      aperture.name = `standing-oval-aperture--${entryKey}`;
      aperture.userData.portalSurfaceWanted = true;
      group.add(aperture);
      const blockedPanel = new THREE.Mesh(
        new THREE.CircleGeometry(0.98, 72),
        new THREE.MeshBasicMaterial({ color: 0x11162a, side: THREE.BackSide })
      );
      blockedPanel.name = `standing-oval-aperture-blocked-side--${entryKey}`;
      blockedPanel.visible = false;
      blockedPanel.userData.portalSurfaceWanted = false;
      group.add(blockedPanel);
      impl.scene.add(group);
      rec = { group, aperture, blockedPanel };
      impl.additionalPortalGroups[entryKey] = rec;
    }
    rec.targetLocationId = entry.target_location_id || null;
    const entryTraversal = entry.traversal || null;
    const entryOneWay = !!(entryTraversal && entryTraversal.mode === "one_way");
    const entryBlockedSide = entryOneWay ? entryTraversal.blocked_entry_side || "back" : null;
    rec.blockedPanel.visible = entryOneWay;
    rec.blockedPanel.userData.portalSurfaceWanted = entryOneWay;
    if (entryOneWay) {
      rec.blockedPanel.position.z = entryBlockedSide === "front" ? 0.02 : -0.02;
      rec.blockedPanel.material.side =
        entryBlockedSide === "front" ? THREE.FrontSide : THREE.BackSide;
    }
    const entryCenter = Array.isArray(entryFrame.position)
      ? entryFrame.position
      : entry.trigger && Array.isArray(entry.trigger.position)
        ? entry.trigger.position
        : [0, 0, 0];
    const entryForward = Array.isArray(entryFrame.forward) ? entryFrame.forward : [0, 0, 1];
    const entryYaw = Math.atan2(Number(entryForward[0]) || 0, Number(entryForward[2]) || 0);
    rec.group.visible = true;
    rec.group.position.set(entryCenter[0], entryCenter[1], entryCenter[2]);
    rec.group.rotation.set(0, entryYaw, 0);
    rec.group.scale.set(
      Math.max(0.001, Number(entryFrame.width_m || 1.8) / 2),
      Math.max(0.001, Number(entryFrame.height_m || 2.8) / 2),
      1
    );
    if (typeof rec.group.updateMatrixWorld === "function") rec.group.updateMatrixWorld(true);
    additionalPortals.push({
      portal_key: entryKey,
      target_location_id: entry.target_location_id || null,
      visual_center: [
        Number(rec.group.position.x.toFixed(3)),
        Number(rec.group.position.y.toFixed(3)),
        Number(rec.group.position.z.toFixed(3)),
      ],
      traversal_mode: entryTraversal ? entryTraversal.mode : "bidirectional",
      one_way: entryOneWay,
      blocked_entry_side: entryBlockedSide,
      blocked_panel_visible: rec.blockedPanel.visible,
      aligned:
        Math.abs(rec.group.position.x - Number(entryCenter[0] || 0)) <= 0.002 &&
        Math.abs(rec.group.position.z - Number(entryCenter[2] || 0)) <= 0.002,
    });
  }
  for (const staleKey of Object.keys(impl.additionalPortalGroups)) {
    if (wantedKeys.has(staleKey)) continue;
    const stale = impl.additionalPortalGroups[staleKey];
    if (stale && stale.group && impl.scene && typeof impl.scene.remove === "function") {
      impl.scene.remove(stale.group);
    }
    delete impl.additionalPortalGroups[staleKey];
  }
  return {
    aligned,
    // N-portal evidence beside the primary's alignment.
    portal_count: portalList.length,
    additional_portals: additionalPortals,
    renderer_kind: sceneInstance.rendererKind,
    trigger_center: center,
    legacy_trigger_center: trigger && trigger.position ? trigger.position.slice(0, 3) : null,
    visual_center: visualCenter,
    visual_forward: frame.forward,
    radius_m: radius,
    oval_width_m: Number(frame.width_m || 0),
    oval_height_m: Number(frame.height_m || 0),
    trigger_depth_m: Number(frame.trigger_depth_m || 0),
    linked_target_portal_id: frame.linked_target_portal_id,
    frame,
    visual_kind: "standing_oval_webgl",
    horizontal_ring_hidden: !impl.portalGroup || impl.portalGroup.visible === false,
    // traversal-direction affordance evidence, read from
    // the LIVE scene graph (not echoed config) so the e2e proves the arrow is
    // gone and the one-way blocked side actually renders opaque.
    traversal_mode: traversal ? traversal.mode : "bidirectional",
    one_way: oneWay,
    blocked_entry_side: blockedSide,
    blocked_panel_visible: !!(
      impl.directionalPortalBlockedPanel && impl.directionalPortalBlockedPanel.visible
    ),
    blocked_panel_opaque: !!(
      impl.directionalPortalBlockedPanel &&
      impl.directionalPortalBlockedPanel.material &&
      impl.directionalPortalBlockedPanel.material.transparent !== true
    ),
    direction_arrow_node_present: !!(
      impl.scene &&
      typeof impl.scene.getObjectByName === "function" &&
      impl.scene.getObjectByName("portal-forward-debug-arrow")
    ),
    reason: aligned ? "standing_oval_aligned_to_portal_frame" : "visual_center_mismatch",
  };
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 3) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (ctx.measureText(trial).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = trial;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  lines.forEach((entry, index) => ctx.fillText(entry, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

function ensurePortalPreviewTexture(impl) {
  if (!impl || !impl.directionalPortalAperture) return null;
  if (!impl.portalPreviewCanvas) {
    impl.portalPreviewCanvas = document.createElement("canvas");
    impl.portalPreviewCanvas.width = 1024;
    impl.portalPreviewCanvas.height = 1024;
    impl.portalPreviewTexture = new THREE.CanvasTexture(impl.portalPreviewCanvas);
    if ("SRGBColorSpace" in THREE) impl.portalPreviewTexture.colorSpace = THREE.SRGBColorSpace;
    impl.portalPreviewTexture.minFilter = THREE.LinearFilter;
    impl.portalPreviewTexture.magFilter = THREE.LinearFilter;
    impl.portalPreviewMaterial = new THREE.MeshBasicMaterial({
      map: impl.portalPreviewTexture,
      transparent: true,
      opacity: 0.96,
      side: THREE.DoubleSide,
    });
    impl.portalPreviewLabelCanvas = document.createElement("canvas");
    impl.portalPreviewLabelCanvas.width = 768;
    impl.portalPreviewLabelCanvas.height = 192;
    impl.portalPreviewLabelTexture = new THREE.CanvasTexture(impl.portalPreviewLabelCanvas);
    if ("SRGBColorSpace" in THREE) impl.portalPreviewLabelTexture.colorSpace = THREE.SRGBColorSpace;
    impl.portalPreviewLabelTexture.minFilter = THREE.LinearFilter;
    impl.portalPreviewLabelTexture.magFilter = THREE.LinearFilter;
    impl.portalPreviewLabelSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: impl.portalPreviewLabelTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }));
    impl.portalPreviewLabelSprite.name = "portal-preview-readable-label";
    impl.portalPreviewLabelSprite.renderOrder = 50;
    impl.directionalPortalGroup.add(impl.portalPreviewLabelSprite);
  }
  return {
    canvas: impl.portalPreviewCanvas,
    texture: impl.portalPreviewTexture,
    material: impl.portalPreviewMaterial,
    aperture: impl.directionalPortalAperture,
    labelCanvas: impl.portalPreviewLabelCanvas,
    labelTexture: impl.portalPreviewLabelTexture,
    labelSprite: impl.portalPreviewLabelSprite,
  };
}

function drawPortalPreviewLabel(canvas, preview) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const sourceType = preview && preview.source_type ? preview.source_type : "none";
  const targetLocation = preview && preview.location_id ? preview.location_id : "unknown-target";
  const targetPortal = preview && preview.target_portal_id ? preview.target_portal_id : "unknown-portal";
  const isLive = isLivePreviewSourceType(sourceType);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(8, 12, 26, 0.82)";
  ctx.strokeStyle = isLive ? "#46d18a" : "#ffcc55";
  ctx.lineWidth = 8;
  ctx.roundRect(8, 8, w - 16, h - 16, 28);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 42px ui-monospace, Menlo, monospace";
  ctx.fillText(
    sourceType === "child_fabric_live_render_texture"
      ? "CHILD FABRIC ATTACHED"
      : isLive
        ? "LIVE TARGET VIEW"
        : "LABELED TARGET FALLBACK",
    w / 2,
    68
  );
  ctx.font = "700 28px ui-monospace, Menlo, monospace";
  ctx.fillStyle = isLive ? "#46d18a" : "#ffcc55";
  ctx.fillText(sourceType, w / 2, 112);
  ctx.font = "24px ui-monospace, Menlo, monospace";
  ctx.fillStyle = "#dbe8ff";
  ctx.fillText(`${targetLocation} · ${targetPortal}`, w / 2, 150);
}

function isLivePreviewSourceType(sourceType) {
  return sourceType === "live_target_render_texture" || sourceType === "child_fabric_live_render_texture";
}

// ADDITIVE preview rung between the static labeled
// placeholder and the live render texture — a labeled top-down snapshot drawn
// from the PREFETCHED portal-neighborhood region (entities, destination portal,
// spawn, occupancy, freshness). Never pretends to be a live render: the header
// says PREFETCHED REGION and isLivePreviewSourceType() stays false for it.
// Existing rungs (placeholder, live RTT, server color/snapshot3d/splats ladder)
// are untouched.
// after painting a region preview, tell the adapter how
// many chunks the drawn entity set covered — the adapter stamps rendered_at
// on those chunks (the render-before-complete evidence trail). Best-effort;
// never throws into the render path.
function ackFabricChunksRendered(portalKey, fp) {
  try {
    if (!portalKey || !adapter || typeof adapter.notifyFabricChunkRendered !== "function") return;
    const region = fp && fp.region ? fp.region : null;
    const chunkCount = region && Array.isArray(region.chunks) ? region.chunks.length : 0;
    if (chunkCount > 0) adapter.notifyFabricChunkRendered(portalKey, chunkCount);
  } catch (e) {
    /* evidence ack is additive */
  }
}

function drawPrefetchedRegionPreview(canvas, preview, fp) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const region = fp && fp.region ? fp.region : {};
  const totals = region.totals || {};
  const occupancy = fp && fp.presence ? fp.presence.occupancy : null;
  const targetLocation = preview && preview.location_id ? preview.location_id : "destination";
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#101a33");
  bg.addColorStop(1, "#1c1226");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.textAlign = "center";
  ctx.fillStyle = "#8fd0ff";
  ctx.font = "700 44px ui-monospace, Menlo, monospace";
  ctx.fillText("PREFETCHED REGION", w / 2, 84);
  ctx.font = "26px ui-monospace, Menlo, monospace";
  ctx.fillStyle = "#dbe8ff";
  ctx.fillText(`${targetLocation} · labeled snapshot (not a live render)`, w / 2, 126);
  // mid-stream the totals are not committed yet — say
  // what is on screen honestly (accumulated chunk entities so far).
  const streaming = region.streaming && region.streaming.active ? region.streaming : null;
  const countLine =
    totals.region_entities != null
      ? `${totals.region_entities} of ${totals.fabric_entities} entities in portal neighborhood`
      : streaming
        ? `streaming: ${streaming.entity_count} entities · chunk ${streaming.chunks_loaded} (near ring first)`
        : "region payload pending";
  ctx.fillText(countLine, w / 2, 162);
  const occLine = occupancy
    ? `${(occupancy.avatars || []).length} known present · arrivals ${occupancy.arrival_count}`
    : "occupancy pending";
  ctx.fillStyle = "#ffd166";
  ctx.fillText(occLine, w / 2, 198);
  const age = region.age_ms != null ? `${Math.round(region.age_ms / 100) / 10}s old` : "";
  if (age) {
    ctx.fillStyle = "#9fb0d0";
    ctx.font = "22px ui-monospace, Menlo, monospace";
    ctx.fillText(`region ${age} · read-only before crossing`, w / 2, 230);
  }

  // Top-down mini-map of the 12x12 destination room around its anchor portal.
  const mapSize = Math.min(w, h) * 0.55;
  const mapX = (w - mapSize) / 2;
  const mapY = h * 0.30;
  const roomM = 12;
  const toMap = (pos) => [
    mapX + ((Number(pos && pos[0]) || 0) + roomM / 2) * (mapSize / roomM),
    mapY + ((Number(pos && pos[2]) || 0) + roomM / 2) * (mapSize / roomM),
  ];
  ctx.strokeStyle = "rgba(219,232,255,0.5)";
  ctx.lineWidth = 3;
  ctx.strokeRect(mapX, mapY, mapSize, mapSize);
  // region circle
  const regionInfo = region.region || {};
  if (Array.isArray(regionInfo.center)) {
    const [cx, cy] = toMap(regionInfo.center);
    ctx.beginPath();
    ctx.strokeStyle = "rgba(70,209,138,0.7)";
    ctx.setLineDash([10, 8]);
    ctx.arc(cx, cy, (Number(regionInfo.radius_m) || 5) * (mapSize / roomM), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // destination anchor portal
  const portalPose = region.destination_portal || null;
  if (portalPose && Array.isArray(portalPose.trigger_position)) {
    const [px, py] = toMap(portalPose.trigger_position);
    ctx.beginPath();
    ctx.strokeStyle = "#ffbd69";
    ctx.lineWidth = 5;
    ctx.ellipse(px, py, 14, 22, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // destination spawn
  const spawn = region.destination_spawn || null;
  if (spawn && Array.isArray(spawn.position)) {
    const [sx, sy] = toMap(spawn.position);
    ctx.fillStyle = "#8fd0ff";
    ctx.fillRect(sx - 6, sy - 6, 12, 12);
  }
  // region entities at their true planar positions, in their own colors
  for (const entity of Array.isArray(region.entities) ? region.entities : []) {
    const [ex, ey] = toMap(entity.position);
    ctx.beginPath();
    ctx.fillStyle = entity.color || "#ffffff";
    ctx.arc(ex, ey, 9, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = "#9fb0d0";
  ctx.font = "20px ui-monospace, Menlo, monospace";
  ctx.fillText("local validation · roi_standard_conformance:false", w / 2, mapY + mapSize + 42);
}

// subtle floor ring showing the LARGER prefetch zone
// around the portal (the smaller traversal trigger stays the oval itself).
// Color tells the state: blue idle, amber in-zone/loading, green warm.
// Player view only (observers have no prefetch machine). Never blocks input —
// it is scene geometry, not UI.
function ensureFabricPrefetchZoneRing(dbg) {
  if (!scene || scene.rendererKind !== "webgl") return;
  const impl = scene._impl;
  if (!impl || !impl.scene) return;
  const fp = dbg ? dbg.fabric_prefetch : null;
  let ring = impl.scene.getObjectByName("fabric-prefetch-zone-ring");
  const controls = dbg ? dbg.controls || {} : {};
  const center = Array.isArray(controls.portal_center) ? controls.portal_center : null;
  const radius =
    fp && fp.supported && fp.zones && fp.zones.prefetch
      ? Number(fp.zones.prefetch.radius_m) || 0
      : 0;
  if (!fp || !center || !(radius > 0)) {
    if (ring) ring.visible = false;
    ensureAdditionalFabricPrefetchZoneRings(impl, dbg);
    return;
  }
  if (ring && ring.userData.radius_m !== radius) {
    impl.scene.remove(ring);
    ring = null;
  }
  if (!ring) {
    const segments = 96;
    const points = [];
    for (let i = 0; i <= segments; i += 1) {
      const a = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0.03, Math.sin(a) * radius));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    ring = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x59c8ff, transparent: true, opacity: 0.55 })
    );
    ring.name = "fabric-prefetch-zone-ring";
    ring.userData.radius_m = radius;
    impl.scene.add(ring);
  }
  ring.position.set(center[0], 0, center[2]);
  ring.visible = true;
  ring.material.color.setHex(
    fp.status === "warm" ? 0x46d18a : fp.zone && fp.zone.inside ? 0xffcc55 : 0x59c8ff
  );
  ensureAdditionalFabricPrefetchZoneRings(impl, dbg);
}

// one zone ring PER NON-FOCUS machine (the focus machine
// owns the legacy-named ring above — single-portal worlds draw exactly one
// ring, byte-identical to pre-004). Ring color still tells the machine state.
function ensureAdditionalFabricPrefetchZoneRings(impl, dbg) {
  if (!impl.additionalFabricZoneRings) impl.additionalFabricZoneRings = {};
  const fp = dbg ? dbg.fabric_prefetch : null;
  const keyed = fp && fp.keyed ? fp.keyed : null;
  const machines = keyed && keyed.machines ? keyed.machines : {};
  const controls = dbg ? dbg.controls || {} : {};
  const portalSummaries = Array.isArray(controls.portals) ? controls.portals : [];
  const focusKey = keyed ? keyed.focus_portal_id : null;
  const wanted = new Set();
  for (const key of Object.keys(machines)) {
    if (key === focusKey) continue;
    const machine = machines[key];
    if (!machine || !machine.supported || !machine.zones || !machine.zones.prefetch) continue;
    const summary = portalSummaries.find((p) => p && p.portal_id === key);
    const ringCenter = summary && Array.isArray(summary.center) ? summary.center : null;
    const ringRadius = Number(machine.zones.prefetch.radius_m) || 0;
    if (!ringCenter || !(ringRadius > 0)) continue;
    wanted.add(key);
    let ring = impl.additionalFabricZoneRings[key];
    if (ring && ring.userData.radius_m !== ringRadius) {
      impl.scene.remove(ring);
      ring = null;
    }
    if (!ring) {
      const segments = 96;
      const points = [];
      for (let i = 0; i <= segments; i += 1) {
        const a = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(a) * ringRadius, 0.03, Math.sin(a) * ringRadius));
      }
      ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x59c8ff, transparent: true, opacity: 0.55 })
      );
      ring.name = `fabric-prefetch-zone-ring--${key}`;
      ring.userData.radius_m = ringRadius;
      impl.scene.add(ring);
      impl.additionalFabricZoneRings[key] = ring;
    }
    ring.position.set(ringCenter[0], 0, ringCenter[2]);
    ring.visible = true;
    ring.material.color.setHex(
      machine.status === "warm" ? 0x46d18a : machine.zone && machine.zone.inside ? 0xffcc55 : 0x59c8ff
    );
  }
  for (const key of Object.keys(impl.additionalFabricZoneRings)) {
    if (wanted.has(key)) continue;
    const stale = impl.additionalFabricZoneRings[key];
    if (stale) impl.scene.remove(stale);
    delete impl.additionalFabricZoneRings[key];
  }
}

// the floating "CHILD FABRIC ATTACHED — LIVE RENDER" DOM
// overlay box (formerly built here via ensurePortalPreviewDomOverlay /
// updatePortalPreviewDomOverlay) has been removed. Its status — child fabric
// attached, live-render-texture, freshness ms, read-only-before-crossing — is
// already carried in the always-visible debug console state: "child fabric"
// (n-child) and "child render" (n-child-render) in the World Navigator card,
// and "source type" / "read-only" / "target" / "freshness" (pr-source,
// pr-readonly, pr-target, pr-freshness) in the Portal preview card — see
// updateNavigatorDebugCard / updatePreviewDebugCard below. The in-scene 3D
// aperture render-to-texture surface (bundle.aperture below) is unrelated and
// stays — it is the actual portal-preview render, not this DOM box.

function drawLabeledPortalPreview(canvas, preview) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const sourceType = preview && preview.source_type ? preview.source_type : "none";
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#28345c");
  bg.addColorStop(0.5, "#151b31");
  bg.addColorStop(1, "#553318");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.strokeStyle = "#d9f4ff";
  ctx.lineWidth = 3;
  for (let i = -5; i <= 5; i += 1) {
    const x = w / 2 + i * 72;
    ctx.beginPath();
    ctx.moveTo(x, h * 0.32);
    ctx.lineTo(w / 2 + i * 125, h * 0.82);
    ctx.stroke();
  }
  for (let j = 0; j < 7; j += 1) {
    const y = h * 0.36 + j * 64;
    ctx.beginPath();
    ctx.moveTo(w * 0.18, y);
    ctx.lineTo(w * 0.82, y);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(w / 2, h * 0.50);
  ctx.strokeStyle = "#ffbd69";
  ctx.fillStyle = "rgba(255, 177, 77, 0.14)";
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.ellipse(0, 0, 185, 310, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-125, 0);
  ctx.lineTo(125, 0);
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = sourceType === "live_target_render_texture" ? "#46d18a" : "#ffcc55";
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.5, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// the preview surface pass now covers EVERY portal — the
// primary keeps the exact pre-004 ladder (child-fabric live RTT when attached,
// else prefetched-region snapshot when warm, else static labeled placeholder);
// each ADDITIONAL portal gets its own canvas on its own aperture running the
// same labeled rungs fed by its own keyed prefetch machine + per-portal
// preview metadata. All existing fidelity modes stay intact underneath.
//
// P4 (#7): `serverBApertureMachine` is RETIRED as an
// aperture machine. It was a synthetic always-warm substitute for
// lobby-portal-b with no perimeter zone, so that portal's window never
// reverted to the image and read as "arbitrary" next to its neighbours. Every
// portal now renders from its OWN keyed prefetch machine under the ONE
// deterministic perimeter gate. The boot-time load below is kept solely as
// the `data-server-b-aperture-entities` reachability probe.
let serverBApertureMachine = null;
// P3: log the adopted-pose identity mismatch once, not per frame.
let primaryEdgeMismatchLogged = false;

async function loadBackendApertureMachine(proxyBase, anchorPortalId) {
  try {
    const response = await fetch(
      `${proxyBase}/fabric/region?anchor_portal_id=${encodeURIComponent(anchorPortalId)}&radius_m=5`,
      { cache: "no-store" }
    );
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload.ok || !Array.isArray(payload.entities) || !payload.entities.length) return null;
    return {
      supported: true,
      status: "warm",
      target_location_id: payload.location_id,
      region: {
        entities: payload.entities,
        avatars: payload.avatars || { avatars: [] },
        region: payload.region,
        // The source aperture already supplies the one visible frame. Keeping
        // the destination return ring would create a doubled-ring blemish.
        destination_portal: null,
        destination_spawn: payload.spawn || null,
        totals: payload.totals || null,
        source: "live destination /fabric/region",
      },
      presence: payload.presence || null,
    };
  } catch (error) {
    console.warn("backend aperture content unavailable", error);
    return null;
  }
}

/** P4: the live camera's world position for viewer-side evidence
 *  (front/back face classification uses the same rule as the render gates). */
function previewCameraWorldPosition(impl) {
  if (!impl || !impl.camera || typeof impl.camera.getWorldPosition !== "function") return null;
  const v = impl.camera.getWorldPosition(new THREE.Vector3());
  return [v.x, v.y, v.z];
}

/** P5 (#3): keep the 2D still-image rung LEGIBLE on whichever face the
 *  viewer looks at. The aperture material is DoubleSide, so the back face
 *  mirrors the CanvasTexture; imageLayerFlipForViewerSide maps P4's viewer side
 *  to the horizontal texture transform that cancels that mirror — identity on
 *  the front (byte-identical pre-P5), a u -> 1 - u flip on the back. Applied to
 *  the ONE texture each 2D rung samples (repeat.x/offset.x only; matrixAutoUpdate
 *  refreshes the uv-transform without re-uploading the canvas). u' = 1 - u stays
 *  in [0,1], so the default ClampToEdge wrap needs no change. The spatial rung
 *  and the billboard label are never flipped (already legible from both faces).
 *  Returns the flip decision for the surface report + evidence. */
function applyPortalImageLayerFlip(texture, viewerSide) {
  const flip = imageLayerFlipForViewerSide(viewerSide);
  if (texture && texture.repeat && texture.offset) {
    texture.repeat.x = flip.repeat_x;
    texture.offset.x = flip.offset_x;
  }
  return flip;
}

/** The full world portal entry (frame + target_frame + traversal) for a
 *  prefetch machine key — the primary portal or any additional portal. */
function worldPortalEntryForKey(key) {
  if (!adapter || !adapter.world || !key) return null;
  const entries =
    Array.isArray(adapter.world.portals) && adapter.world.portals.length
      ? adapter.world.portals
      : adapter.world.portal
        ? [adapter.world.portal]
        : [];
  for (const entry of entries) {
    if (appPortalKey(entry) === key) return entry;
  }
  return null;
}

/** Try the spatial rung for one portal aperture. Returns the surface
 *  report when the spatial render took the aperture, else null (the caller
 *  falls through to the pre-011 ladder unchanged). */
function trySpatialApertureSurface(portalKey, machine, apertureMesh) {
  if (!sceneRuntimeController || !portalKey || !machine || !apertureMesh) return null;
  const entry = worldPortalEntryForKey(portalKey);
  if (!entry) return null;
  const surface = sceneRuntimeController.portalSurface(portalKey, machine, entry);
  if (!surface) return null;
  apertureMesh.material = surface.material;
  apertureMesh.position.z = 0.012;
  // Render acks keep stamping progressive chunks (render-before-
  // complete evidence) — the spatial rung paints the same accumulated set.
  ackFabricChunksRendered(portalKey, machine);
  return surface;
}

function updatePortalPreviewSurface(debug) {
  const primary = updatePrimaryPortalPreviewSurface(debug);
  const additional = updateAdditionalPortalPreviewSurfaces(debug);
  if (primary && additional.length) primary.additional_portals = additional;
  return primary;
}

function updateAdditionalPortalPreviewSurfaces(debug) {
  if (!isPlayer || !scene || !debug) return [];
  const impl = scene._impl;
  if (!impl || scene.rendererKind !== "webgl" || !impl.additionalPortalGroups) return [];
  const keyedMachines =
    debug.fabric_prefetch && debug.fabric_prefetch.keyed && debug.fabric_prefetch.keyed.machines
      ? debug.fabric_prefetch.keyed.machines
      : {};
  const portalPreviews = debug.portal_previews || {};
  const cameraPosition = previewCameraWorldPosition(impl);
  const results = [];
  for (const key of Object.keys(impl.additionalPortalGroups)) {
    const rec = impl.additionalPortalGroups[key];
    if (!rec || !rec.aperture) continue;
    if (!rec.previewCanvas) {
      rec.previewCanvas = document.createElement("canvas");
      rec.previewCanvas.width = 1024;
      rec.previewCanvas.height = 1024;
      rec.previewTexture = new THREE.CanvasTexture(rec.previewCanvas);
      if ("SRGBColorSpace" in THREE) rec.previewTexture.colorSpace = THREE.SRGBColorSpace;
      rec.previewTexture.minFilter = THREE.LinearFilter;
      rec.previewTexture.magFilter = THREE.LinearFilter;
      rec.previewMaterial = new THREE.MeshBasicMaterial({
        map: rec.previewTexture,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
      });
    }
    // P4 (#7): every portal — lobby-portal-b included — renders from
    // its OWN keyed prefetch machine; the always-warm serverBApertureMachine
    // substitute is retired (see its declaration comment). One deterministic
    // perimeter gate governs live-vs-image for all portals alike.
    const machine = keyedMachines[key] || null;
    const entry = worldPortalEntryForKey(key);
    const liveGate = portalPerimeterLiveGate(machine);
    const viewerSide = cameraPosition && entry ? portalViewerSide(cameraPosition, entry) : null;
    // the spatial rung per ADDITIONAL portal — each
    // lobby portal window renders ITS OWN destination (keyed machine + keyed
    // record; no cross-contamination by construction).
    const spatialSurface = trySpatialApertureSurface(key, machine, rec.aperture);
    if (spatialSurface) {
      results.push({
        portal_key: key,
        surface: "standing_oval_aperture_mesh",
        source_type: "prefetched_region_spatial_render",
        region_backed: true,
        target_location_id: rec.targetLocationId || null,
        live_gate: liveGate,
        viewer_side: viewerSide,
        spatial_render: spatialSurface.debug,
      });
      continue;
    }
    const preview =
      portalPreviews[key] || {
        source_type: "target_static_placeholder_labeled",
        location_id: rec.targetLocationId || "destination",
        target_portal_id: null,
      };
    // the region rung also draws MID-STREAM — the chunk
    // pipeline surfaces accumulated entities while loading, so the near ring
    // renders before the far ring has even arrived (progressive rendering).
    const regionBacked = !!(
      machine &&
      (machine.status === "warm" ||
        machine.status === "cooling" ||
        (machine.status === "loading" && machine.region && machine.region.streaming)) &&
      machine.region &&
      Array.isArray(machine.region.entities)
    );
    const imageSignature = [
      regionBacked ? "region" : "label",
      preview.source_type || "",
      preview.location_id || "",
      machine?.status || "",
      machine?.region?.loaded_at_ms || "",
      machine?.region?.chunks?.length || 0,
      machine?.region?.entities?.length || 0,
    ].join("|");
    if (imageSignature !== rec.previewImageSignature) {
      rec.previewImageSignature = imageSignature;
      if (regionBacked) {
        drawPrefetchedRegionPreview(rec.previewCanvas, preview, machine);
        ackFabricChunksRendered(key, machine);
      } else {
        drawLabeledPortalPreview(rec.previewCanvas, preview);
      }
      rec.previewTexture.needsUpdate = true;
    }
    rec.aperture.material = rec.previewMaterial;
    rec.aperture.position.z = 0.012;
    // P5 (#3): flip the still-image texture so it stays legible on the
    // face the viewer is on (front identity / back horizontal mirror).
    const imageFlip = applyPortalImageLayerFlip(rec.previewTexture, viewerSide);
    results.push({
      portal_key: key,
      surface: "standing_oval_aperture_mesh",
      source_type: regionBacked
        ? "prefetched_region_snapshot_labeled"
        : preview.source_type || "target_static_placeholder_labeled",
      region_backed: regionBacked,
      target_location_id: rec.targetLocationId || preview.location_id || null,
      // P4: both 2D rungs are IMAGE surfaces — permitted outside the
      // perimeter (this is #7's "show the still image"); the gate verdict
      // records why the live spatial render did not own this aperture.
      live_gate: liveGate,
      viewer_side: viewerSide,
      // P5: the per-face legibility transform applied to this rung.
      image_layer: imageFlip,
    });
  }
  return results;
}

function updatePrimaryPortalPreviewSurface(debug) {
  if (!isPlayer || !scene || !debug || !debug.preview) return null;
  const impl = scene._impl;
  if (!impl || scene.rendererKind !== "webgl" || !impl.directionalPortalAperture) {
    document.body.setAttribute("data-portal-preview-surface-active", "false");
    document.body.setAttribute("data-portal-preview-surface", "");
    return {
      active: false,
      renderer_kind: scene ? scene.rendererKind : "none",
      reason: "portal_preview_requires_webgl_oval_aperture",
    };
  }
  const bundle = ensurePortalPreviewTexture(impl);
  if (!bundle) {
    document.body.setAttribute("data-portal-preview-surface-active", "false");
    document.body.setAttribute("data-portal-preview-surface", "");
    return { active: false, renderer_kind: scene.rendererKind, reason: "portal_preview_aperture_missing" };
  }
  // the SEAMLESS SPATIAL RUNG. While the keyed prefetch
  // machine for THIS portal has warm (or progressively streaming) destination
  // content, the aperture becomes a true window: the prefetched destination
  // region + destination-circle avatars rendered in destination coordinates
  // through the crossing's own camera mapping. Outranks the child-fabric
  // scaffold RTT and the 2D labeled snapshot; every pre-011 rung below stays
  // intact and is the immediate fallback (cold portal, blocked side, no
  // webgl, chunk-less server).
  const keyedForPrimary =
    debug.fabric_prefetch && debug.fabric_prefetch.keyed && debug.fabric_prefetch.keyed.machines
      ? debug.fabric_prefetch.keyed.machines
      : null;
  const primaryEntryKey =
    adapter && adapter.world && adapter.world.portal ? appPortalKey(adapter.world.portal) : null;
  const primaryMachine =
    keyedForPrimary && primaryEntryKey && keyedForPrimary[primaryEntryKey]
      ? keyedForPrimary[primaryEntryKey]
      : debug.fabric_prefetch || null;
  // P3: the focus portal's shared-edge identity — the served region
  // pose provably belongs to THIS portal's own stable connection (
  // client half). Surfaced on every rung (spatial or fallback); additive only.
  const primaryEdge = portalSharedEdgeIdentity(
    primaryMachine,
    adapter && adapter.world ? adapter.world.portal : null
  );
  document.body.setAttribute("data-portal-edge-id", (primaryEdge && primaryEdge.edge_id) || "");
  document.body.setAttribute(
    "data-portal-edge-verified",
    primaryEdge && primaryEdge.available ? String(primaryEdge.verified === true) : ""
  );
  document.body.setAttribute(
    "data-portal-edge-reason",
    primaryEdge && !primaryEdge.available
      ? primaryEdge.reason || ""
      : primaryEdge && primaryEdge.verified !== true
        ? (primaryEdge.failures || []).join(",")
        : ""
  );
  if (primaryEdge && primaryEdge.available && primaryEdge.verified !== true && !primaryEdgeMismatchLogged) {
    primaryEdgeMismatchLogged = true;
    logLine(
      `portal identity: WARNING — adopted pose does not belong to this portal's edge ` +
        `(${(primaryEdge.failures || []).join(", ")}; expected ${primaryEdge.expected_edge_id})`
    );
  }
  // P4: the focus portal's deterministic perimeter verdict (#7) and the
  // camera's face of the portal (#2) — surfaced every pass so the live->image
  // flip is provably tied to the circle, whichever rung wins below.
  const primaryLiveGate = portalPerimeterLiveGate(primaryMachine);
  const primaryViewerSide = portalViewerSide(
    previewCameraWorldPosition(impl),
    adapter && adapter.world ? adapter.world.portal : null
  );
  document.body.setAttribute("data-portal-perimeter-live", String(primaryLiveGate.live === true));
  document.body.setAttribute("data-portal-perimeter-reason", primaryLiveGate.reason || "");
  document.body.setAttribute(
    "data-portal-perimeter-inside",
    primaryLiveGate.inside == null ? "" : String(primaryLiveGate.inside)
  );
  document.body.setAttribute(
    "data-portal-perimeter-distance-m",
    primaryLiveGate.distance_m == null ? "" : String(primaryLiveGate.distance_m)
  );
  document.body.setAttribute(
    "data-portal-perimeter-radius-m",
    primaryLiveGate.radius_m == null ? "" : String(primaryLiveGate.radius_m)
  );
  document.body.setAttribute(
    "data-portal-perimeter-exit-radius-m",
    primaryLiveGate.exit_radius_m == null ? "" : String(primaryLiveGate.exit_radius_m)
  );
  document.body.setAttribute(
    "data-portal-viewer-side",
    primaryViewerSide && primaryViewerSide.side ? primaryViewerSide.side : ""
  );
  const spatialSurface = trySpatialApertureSurface(primaryEntryKey, primaryMachine, bundle.aperture);
  if (spatialSurface) {
    if (bundle.labelSprite) bundle.labelSprite.visible = false;
    // P5: the live spatial window owns the aperture — the 2D still-image
    // layer (and its per-face flip) is not showing on this pass.
    document.body.setAttribute("data-portal-image-layer-active", "false");
    document.body.setAttribute("data-portal-preview-surface-active", "true");
    document.body.setAttribute("data-portal-preview-surface", "standing_oval_aperture_mesh");
    document.body.setAttribute("data-portal-preview-source-type", "prefetched_region_spatial_render");
    return {
      active: true,
      renderer_kind: scene.rendererKind,
      surface: "standing_oval_aperture_mesh",
      source_type: "prefetched_region_spatial_render",
      render_source: "prefetched_region_spatial_render_target",
      region_backed: true,
      fallback_labeled: false,
      readonly: debug.preview.readonly === true,
      target_location_id:
        (adapter.world.portal && adapter.world.portal.target_location_id) ||
        debug.preview.location_id ||
        null,
      target_portal_id: debug.preview.target_portal_id || null,
      fed_by_fabric_prefetch: true,
      live_gate: primaryLiveGate,
      viewer_side: primaryViewerSide,
      spatial_render: spatialSurface.debug,
    };
  }
  // when the child fabric is attached and rendering, the aperture shows
  // the REAL child-fabric render texture (world B built from B's own fabric
  // manifest) instead of static labeled placeholder.
  if (impl.childFabricRender && impl.childFabricRender.active) {
    bundle.aperture.material = impl.childFabricRender.material;
    bundle.aperture.position.z = 0.012;
    if (bundle.labelSprite) bundle.labelSprite.visible = false;
    // P5: the live child-fabric render owns the aperture — the 2D
    // still-image layer is not showing on this pass.
    document.body.setAttribute("data-portal-image-layer-active", "false");
    document.body.setAttribute("data-portal-preview-surface-active", "true");
    document.body.setAttribute("data-portal-preview-surface", "standing_oval_aperture_mesh");
    document.body.setAttribute("data-portal-preview-source-type", debug.preview.source_type || "");
    return {
      active: true,
      renderer_kind: scene.rendererKind,
      surface: "standing_oval_aperture_mesh",
      source_type: debug.preview.source_type,
      render_source: "child_fabric_render_target",
      child_fabric_url: debug.preview.child_fabric_url || null,
      fallback_labeled: false,
      readonly: debug.preview.readonly === true,
      target_location_id: debug.preview.location_id || null,
      target_portal_id: debug.preview.target_portal_id || null,
      // the live rung is now provably BACKED by addressed,
      // zone-gated prefetch data once the machine is warm (additive evidence).
      fed_by_fabric_prefetch: !!(
        debug.fabric_prefetch &&
        debug.fabric_prefetch.status === "warm" &&
        debug.fabric_prefetch.region &&
        debug.fabric_prefetch.region.totals
      ),
      // P4: this rung is the boot-attached LOCAL child-fabric
      // scaffold (no ongoing server subscription), so #7's perimeter gate does
      // not retire it; the gate verdict is still surfaced for the flip proof.
      live_gate: primaryLiveGate,
      viewer_side: primaryViewerSide,
    };
  }
  // ADDITIVE fallback rung selection. With no live render
  // available, prefer the labeled PREFETCHED-REGION snapshot when the prefetch
  // machine is warm (or cooling with an unexpired payload); otherwise the
  // original static labeled placeholder renders exactly as before.
  const fabricPrefetch = debug.fabric_prefetch || null;
  // the region rung also draws MID-STREAM (see the
  // additional-portal surface) — progressive rendering of the chunk pipeline.
  const regionBacked = !!(
    fabricPrefetch &&
    (fabricPrefetch.status === "warm" ||
      fabricPrefetch.status === "cooling" ||
      (fabricPrefetch.status === "loading" &&
        fabricPrefetch.region &&
        fabricPrefetch.region.streaming)) &&
    fabricPrefetch.region &&
    Array.isArray(fabricPrefetch.region.entities)
  );
  const imageSignature = [
    regionBacked ? "region" : "label",
    debug.preview.source_type || "",
    debug.preview.location_id || "",
    fabricPrefetch?.status || "",
    fabricPrefetch?.region?.loaded_at_ms || "",
    fabricPrefetch?.region?.chunks?.length || 0,
    fabricPrefetch?.region?.entities?.length || 0,
  ].join("|");
  // `ensurePortalPreviewTexture` returns a lightweight view object each pass;
  // keep the repaint signature on the stable scene implementation instead.
  if (imageSignature !== impl.portalPreviewImageSignature) {
    impl.portalPreviewImageSignature = imageSignature;
    if (regionBacked) {
      drawPrefetchedRegionPreview(bundle.canvas, debug.preview, fabricPrefetch);
      ackFabricChunksRendered(fabricPrefetch.portal_key, fabricPrefetch);
    } else {
      drawLabeledPortalPreview(bundle.canvas, debug.preview);
    }
    bundle.texture.needsUpdate = true;
  }
  bundle.aperture.material = bundle.material;
  bundle.aperture.position.z = 0.012;
  if (bundle.labelSprite) bundle.labelSprite.visible = false;
  // P5 (#3): this is the far-away still-image rung — flip its texture so
  // it reads legibly on whichever face the viewer is on (front identity / back
  // horizontal mirror). The spatial + child-fabric rungs above are untouched.
  const primaryImageFlip = applyPortalImageLayerFlip(bundle.texture, primaryViewerSide);
  document.body.setAttribute("data-portal-image-layer-active", "true");
  document.body.setAttribute("data-portal-image-flip", String(primaryImageFlip.mirrored === true));
  document.body.setAttribute("data-portal-image-legible", String(primaryImageFlip.legible_on_viewed_face === true));
  const effectiveSourceType = regionBacked
    ? "prefetched_region_snapshot_labeled"
    : debug.preview.source_type;
  document.body.setAttribute("data-portal-preview-surface-active", "true");
  document.body.setAttribute("data-portal-preview-surface", "standing_oval_aperture_mesh");
  document.body.setAttribute("data-portal-preview-source-type", effectiveSourceType || "");
  return {
    active: true,
    renderer_kind: scene.rendererKind,
    surface: "standing_oval_aperture_mesh",
    source_type: effectiveSourceType,
    fallback_labeled: !isLivePreviewSourceType(effectiveSourceType),
    region_backed: regionBacked,
    readonly: debug.preview.readonly === true,
    target_location_id: debug.preview.location_id || null,
    target_portal_id: debug.preview.target_portal_id || null,
    // P4: both 2D rungs are IMAGE surfaces (#7's "show the still
    // image" outside the circle); the verdict says why live did not own it.
    live_gate: primaryLiveGate,
    viewer_side: primaryViewerSide,
    // P5: the per-face legibility transform applied to this rung.
    image_layer: primaryImageFlip,
  };
}

/**
 * attach the child fabric to the ONE scene and point the aperture at a
 * live render of it. Called once after adapter + scene are ready (player only).
 */
function setupWorldNavigatorRender() {
  if (!isPlayer || !scene || !adapter || typeof adapter.setChildFabricRenderState !== "function") return;
  const impl = scene._impl;
  const navigatorDebug = adapter.debugState().navigator || null;
  if (impl && impl.scene && scene.rendererKind === "webgl" && navigatorDebug) {
    buildRootFabricNodeVisuals(impl, navigatorDebug);
  }
  const manifest = typeof adapter.childFabricManifest === "function" ? adapter.childFabricManifest() : null;
  if (!manifest) {
    adapter.setChildFabricRenderState({ active: false, reason: "child_fabric_not_loaded" });
    return;
  }
  if (scene.rendererKind !== "webgl" || !impl || !impl.scene || !impl.renderer) {
    adapter.setChildFabricRenderState({
      active: false,
      reason: `renderer_is_${scene.rendererKind}; child fabric loaded in-context but labeled placeholder shown`,
    });
    return;
  }
  if (!impl.directionalPortalAperture) {
    adapter.setChildFabricRenderState({ active: false, reason: "standing_oval_aperture_unavailable" });
    return;
  }

  const attachment = navigatorDebug && navigatorDebug.portal_attachment ? navigatorDebug.portal_attachment : {};
  const childInfo = navigatorDebug && navigatorDebug.child_fabric ? navigatorDebug.child_fabric : {};
  const childPortal = childInfo.child_portal_node && Array.isArray(childInfo.child_portal_node.position)
    ? childInfo.child_portal_node.position.slice(0, 3)
    : [2.8, 0, -2.8];
  const childSpawn = childInfo.child_spawn_node && Array.isArray(childInfo.child_spawn_node.position)
    ? childInfo.child_spawn_node.position.slice(0, 3)
    : [-0.4, 0, -2.8];
  const dirRaw = [childSpawn[0] - childPortal[0], 0, childSpawn[2] - childPortal[2]];
  const dirLen = Math.hypot(dirRaw[0], dirRaw[2]) || 1;
  const dir = [dirRaw[0] / dirLen, 0, dirRaw[2] / dirLen];
  const right = [dir[2], 0, -dir[0]];
  const portalYaw = Math.atan2(dir[0], dir[2]);

  // Accent the child fabric by which world it is (A = blue, B = orange), so
  // after a promotion the re-attached child (the world behind us) reads right.
  const childIsLocationA = String(childInfo.container || "").toLowerCase() === "location-a";
  const group = buildChildFabricGroup(manifest, {
    url: childInfo.url || null,
    attachedAtNodeId: attachment.node_id || null,
    portalYaw,
    labelPosition: [childSpawn[0], 0, childSpawn[2]],
    accent: childIsLocationA ? 0x3aa0ff : 0xff7a3a,
    accentFill: childIsLocationA ? 0x2bd4ff : 0xffb14d,
    accentCss: childIsLocationA ? "#2bd4ff" : "#ffb14d",
    suppressReturnPortal: true,
  });
  impl.scene.add(group);

  const renderTarget = new THREE.WebGLRenderTarget(768, 768, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  if ("SRGBColorSpace" in THREE) renderTarget.texture.colorSpace = THREE.SRGBColorSpace;
  const frame = adapter.world && adapter.world.portal ? adapter.world.portal.frame : null;
  const apertureAspect =
    frame && Number(frame.width_m) > 0 && Number(frame.height_m) > 0
      ? Number(frame.width_m) / Number(frame.height_m)
      : 1.8 / 2.8;
  const camera = new THREE.PerspectiveCamera(62, apertureAspect, 0.05, 60);
  camera.layers.set(CHILD_FABRIC_LAYER);
  impl.childFabricRender = {
    active: true,
    group,
    renderTarget,
    camera,
    material: new THREE.MeshBasicMaterial({
      map: renderTarget.texture,
      side: THREE.DoubleSide,
      toneMapped: false,
      transparent: true,
      opacity: 0.96,
    }),
    clearColor: new THREE.Color(
      hexColorFromFabricBackground(manifest.primary ? manifest.primary.background : null)
    ),
    anchor: { portal: childPortal, spawn: childSpawn, dir, right },
    camera_source: "child_fabric_portal_node->child_spawn_node (source-camera parallax)",
  };
  adapter.setChildFabricRenderState({
    active: true,
    surface: "standing_oval_aperture_mesh",
    render_kind: "webgl_render_target",
    texture_size: 768,
    layer: CHILD_FABRIC_LAYER,
    single_scene: true,
    scene_shared_with_root: true,
    camera_source: impl.childFabricRender.camera_source,
    attached_at_portal_node: attachment.node_id || null,
    attachment_transform_position: attachment.transform_position || null,
    group_name: group.name,
  });
  logLine(
    `world-navigator: child fabric '${childInfo.container || "?"}' attached at portal node ` +
      `${attachment.node_id || "?"} (bSubtype 255); aperture now renders the live child-fabric texture`
  );
}

/**
 * rebuild the visible scene around the CURRENT root fabric after a
 * promotion (crossing) or a demotion (reset) — inside the SAME JS context.
 * The vendor Scene instance is disposed and recreated (its dispose() cancels
 * the rAF loop and removes the canvas); the avatar/equipment layer (VRM) is
 * NEVER torn down, so equipment stays attached across the crossing. This is
 * the render-side half of "promote fabric B to the active/root frame".
 */
function recomposeActiveWorldScene(reason) {
  return sceneRuntimeController.recomposeLive(reason);
}

function writeDebugText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function writeDebugBool(id, value) {
  const el = $(id);
  if (!el) return;
  if (typeof value !== "boolean") {
    el.textContent = "—";
    el.classList.remove("debug-true", "debug-false");
    return;
  }
  el.textContent = String(value);
  el.classList.toggle("debug-true", value === true);
  el.classList.toggle("debug-false", value === false);
}

function pressedControlLabels() {
  const snapshot = movementCameraController ? movementCameraController.movementDebug() : null;
  return snapshot ? snapshot.keys : "none";
}

function updateMovementDebug(dbg, movementState = null) {
  const movement = movementState || (movementCameraController ? movementCameraController.updateMovementDebug(dbg) : {
    previous_position: null,
    last_delta: [0, 0, 0],
    last_key_event: "none",
    keys: "none",
  });
  const av = dbg && dbg.avatar;
  const pos = av && Array.isArray(av.position) ? av.position : null;
  const controls = dbg && dbg.controls ? dbg.controls : {};
  if (!pos) {
    writeDebugText("m-keys", pressedControlLabels());
    writeDebugText("m-pos", "—");
    writeDebugText("m-delta", "—");
    writeDebugText("m-move-dir", "—");
    writeDebugText("m-rot", "—");
    writeDebugText("m-facing", "—");
    writeDebugText("m-flags", "—");
    const camera = movementCameraController ? movementCameraController.playerCameraDebug() : null;
    writeDebugText("m-cam-yaw", camera ? fixed3(camera.rotation_y) : "—");
    writeDebugText("m-jump", "—");
    writeDebugText("m-portal-dist", "—");
    writeDebugBool("m-inside", null);
    writeDebugBool("m-auto", null);
    writeDebugText("m-last-key", movement.last_key_event);
    updatePortalDebug(dbg);
    return;
  }

  const movementMode = controls.movement_mode || (controls.moving ? "walk" : "idle");
  const groundedLabel = controls.grounded ? "grounded" : "airborne";
  const keys = movement.keys || pressedControlLabels();
  const positionLabel = vec3Label(pos);
  const deltaLabel = vec3Label(movement.last_delta);
  const portalDistance = fixed3(controls.portal_distance_m);

  writeDebugText("m-keys", keys);
  writeDebugText("m-pos", positionLabel);
  writeDebugText("m-delta", deltaLabel);
  writeDebugText("m-move-dir", controls.movement_direction || "none");
  writeDebugText("m-rot", fixed3(av.rotation_y));
  writeDebugText("m-facing", controls.facing_semantics || "still");
  writeDebugText("m-flags", `${movementMode} · ${fixed3(controls.speed_mps)} m/s / ${groundedLabel}`);
  const camera = movementCameraController ? movementCameraController.playerCameraDebug() : null;
  writeDebugText("m-cam-yaw", camera ? fixed3(camera.rotation_y) : "—");
  writeDebugText("m-jump", fixed3(controls.jump_height_m));
  writeDebugText("m-portal-dist", portalDistance);
  writeDebugBool("m-inside", controls.inside_portal_trigger);
  writeDebugBool("m-auto", controls.auto_handoff_ready);
  writeDebugText("m-last-key", movement.last_key_event);
  updatePortalDebug(dbg);

  document.body.setAttribute("data-avatar-keys", keys);
  document.body.setAttribute("data-avatar-position", positionLabel);
  document.body.setAttribute("data-avatar-delta", deltaLabel);
  document.body.setAttribute("data-avatar-rotation-y", fixed3(av.rotation_y));
  document.body.setAttribute("data-portal-distance", portalDistance);
  document.body.setAttribute("data-auto-handoff-ready", String(controls.auto_handoff_ready === true));
}

function updatePortalDebug(dbg) {
  const controls = dbg && dbg.controls ? dbg.controls : {};
  const movementMode = controls.movement_mode || (controls.moving ? "walk" : "idle");
  const visibility = dbg && dbg.visibility ? dbg.visibility : {};
  const visualAlignment = dbg && dbg.portal_visual_alignment ? dbg.portal_visual_alignment : {};
  const payload = dbg && dbg.last_handoff_payload;
  const pose = dbg && dbg.last_pose_payload;
  const payloadTransform = payload && payload.avatar_context && payload.avatar_context.transform;
  const payloadFrameTransform = payload && payload.avatar_context && payload.avatar_context.portal_frame_transform;
  const mappedExitTransform =
    (payloadFrameTransform && payloadFrameTransform.mapped_exit_transform) ||
    controls.mapped_exit_transform ||
    null;
  const local = controls.portal_local_coordinates || {};
  const poseFields = pose
    ? [
        "transform",
        "pose_snapshot",
        "locomotion_state",
        "portal_entry_transform",
        "portal_center_transform",
        "portal_departure_transform",
        "portal_exit_transform",
        "portal_frame_transform",
        "mapped_exit_transform",
      ]
        .filter((key) => Object.prototype.hasOwnProperty.call(pose, key))
        .join(" ")
    : "—";

  writeDebugText("p-location", dbg && dbg.location_id ? dbg.location_id : "—");
  writeDebugText("p-phase", controls.portal_transition_phase || "none");
  writeDebugText("p-center", vec3Label(controls.portal_center));
  writeDebugText("p-radius", fixed3(controls.portal_radius_m));
  writeDebugText("p-distance", fixed3(controls.portal_distance_m));
  writeDebugText("p-frame-id", controls.portal_frame_id || "—");
  writeDebugText("p-frame-forward", vec3Label(controls.portal_frame_forward));
  writeDebugText("p-frame-right", vec3Label(controls.portal_frame_right));
  writeDebugText(
    "p-frame-size",
    controls.portal_frame_width_m && controls.portal_frame_height_m
      ? `${fixed3(controls.portal_frame_width_m)} / ${fixed3(controls.portal_frame_height_m)}`
      : "—"
  );
  writeDebugText("p-trigger-depth", fixed3(controls.portal_trigger_depth_m));
  writeDebugText(
    "p-local",
    local && typeof local.x === "number" ? `${fixed3(local.x)}, ${fixed3(local.y)}, ${fixed3(local.z)}` : "—"
  );
  writeDebugText("p-plane-distance", fixed3(controls.portal_signed_plane_distance_m));
  writeDebugBool("p-inside-oval", controls.inside_oval_aperture);
  writeDebugBool("p-inside-volume", controls.inside_trigger_volume);
  writeDebugText(
    "p-crossing",
    controls.portal_entry_crossing_direction ||
      controls.portal_last_crossing_direction ||
      controls.portal_crossing_direction ||
      "—"
  );
  writeDebugText("p-linked-portal", controls.portal_linked_target_portal_id || "—");
  writeDebugText("p-target", controls.portal_target_location_id || "—");
  writeDebugBool("p-rearmed", controls.portal_trigger_rearmed);
  writeDebugBool("p-handshake", controls.return_handshake_ready || controls.portal_handshake_ready);
  writeDebugText("p-blocker", controls.portal_ready_blocker || "—");
  writeDebugText("p-visual-center", vec3Label(visualAlignment.visual_center));
  writeDebugBool("p-visual-aligned", visualAlignment.aligned);
  writeDebugText("p-move-dir", controls.movement_direction || "none");
  writeDebugText("p-facing", controls.facing_semantics || "still");
  writeDebugText("p-visible", visibility.visible_avatar_count === undefined ? "—" : String(visibility.visible_avatar_count));
  writeDebugBool("p-invariant", visibility.one_avatar_visible_invariant);
  writeDebugText("p-direction", dbg && dbg.last_handoff_direction ? dbg.last_handoff_direction : "—");
  writeDebugText("p-payload-pos", payloadTransform ? vec3Label(payloadTransform.position) : "—");
  writeDebugText("p-payload-yaw", payloadTransform ? fixed3(payloadTransform.rotation_y) : "—");
  writeDebugText("p-mapped-exit-pos", mappedExitTransform ? vec3Label(mappedExitTransform.position) : "—");
  writeDebugText("p-mapped-exit-yaw", mappedExitTransform ? fixed3(mappedExitTransform.rotation_y) : fixed3(controls.mapped_exit_yaw));
  writeDebugText("p-pose-fields", poseFields);

  document.body.setAttribute("data-active-location", dbg && dbg.location_id ? dbg.location_id : "");
  document.body.setAttribute("data-portal-transition-phase", controls.portal_transition_phase || "none");
  document.body.setAttribute("data-portal-center", vec3Label(controls.portal_center));
  document.body.setAttribute("data-portal-radius", fixed3(controls.portal_radius_m));
  document.body.setAttribute("data-portal-frame-id", controls.portal_frame_id || "");
  document.body.setAttribute("data-portal-frame-forward", vec3Label(controls.portal_frame_forward));
  document.body.setAttribute("data-portal-frame-right", vec3Label(controls.portal_frame_right));
  document.body.setAttribute("data-portal-frame-size", `${fixed3(controls.portal_frame_width_m)},${fixed3(controls.portal_frame_height_m)}`);
  document.body.setAttribute("data-portal-trigger-depth", fixed3(controls.portal_trigger_depth_m));
  document.body.setAttribute("data-portal-local-coordinates", local && typeof local.x === "number" ? `${fixed3(local.x)},${fixed3(local.y)},${fixed3(local.z)}` : "");
  document.body.setAttribute("data-portal-signed-plane-distance", fixed3(controls.portal_signed_plane_distance_m));
  document.body.setAttribute("data-inside-oval-aperture", String(controls.inside_oval_aperture === true));
  document.body.setAttribute("data-inside-trigger-volume", String(controls.inside_trigger_volume === true));
  document.body.setAttribute("data-portal-crossing-direction", controls.portal_crossing_direction || "");
  document.body.setAttribute("data-portal-entry-crossing-direction", controls.portal_entry_crossing_direction || "");
  document.body.setAttribute("data-portal-traversal-mode", controls.portal_traversal_mode || "");
  document.body.setAttribute("data-portal-allowed-entry-side", controls.portal_allowed_entry_side || "");
  document.body.setAttribute("data-portal-current-entry-side", controls.portal_current_entry_side || "");
  document.body.setAttribute("data-portal-entry-side-allowed", String(controls.portal_entry_side_allowed !== false));
  document.body.setAttribute("data-portal-traversal-rejected-count", String(controls.portal_traversal_rejected_count || 0));
  document.body.setAttribute("data-portal-transition-phase-history", Array.isArray(controls.portal_transition_phase_history) ? controls.portal_transition_phase_history.join(",") : "");
  document.body.setAttribute("data-linked-target-portal", controls.portal_linked_target_portal_id || "");
  document.body.setAttribute("data-portal-target-location", controls.portal_target_location_id || "");
  document.body.setAttribute("data-portal-trigger-rearmed", String(controls.portal_trigger_rearmed === true));
  document.body.setAttribute("data-portal-handshake-ready", String((controls.return_handshake_ready || controls.portal_handshake_ready) === true));
  document.body.setAttribute("data-portal-ready-blocker", controls.portal_ready_blocker || "");
  document.body.setAttribute("data-portal-visual-center", vec3Label(visualAlignment.visual_center));
  document.body.setAttribute("data-portal-visual-aligned", String(visualAlignment.aligned === true));
  document.body.setAttribute("data-movement-direction", controls.movement_direction || "none");
  document.body.setAttribute("data-movement-mode", movementMode);
  document.body.setAttribute("data-run-mode", String(controls.run_mode === true));
  document.body.setAttribute("data-movement-speed-mps", fixed3(controls.speed_mps));
  document.body.setAttribute("data-facing-semantics", controls.facing_semantics || "still");
  document.body.setAttribute("data-visible-avatar-count", visibility.visible_avatar_count === undefined ? "" : String(visibility.visible_avatar_count));
  document.body.setAttribute("data-one-avatar-invariant", String(visibility.one_avatar_visible_invariant === true));
  document.body.setAttribute("data-handoff-direction", dbg && dbg.last_handoff_direction ? dbg.last_handoff_direction : "");
  document.body.setAttribute("data-mapped-exit-position", mappedExitTransform ? vec3Label(mappedExitTransform.position) : "");
  document.body.setAttribute("data-mapped-exit-yaw", mappedExitTransform ? fixed3(mappedExitTransform.rotation_y) : fixed3(controls.mapped_exit_yaw));
  document.body.setAttribute("data-payload-pose-fields", poseFields);
}

// render the GeoPose-SHAPED positioning card. The avatar's
// local Cartesian transform is mapped (in live-adapter.js) into a structure
// SHAPED like OGC GeoPose 1.0 (21-056r11) Basic-YPR + Basic-Quaternion. This is
// a demonstration mapping ONLY — NOT OGC-conformant, NOT georeferenced; the
// lat/lon/h come from an illustrative fake origin. standards_conformance:false.
function updateGeoPoseDebug(dbg) {
  const gp = dbg && dbg.geopose_shaped_pose;
  const ypr = gp && gp.basic_ypr;
  const quat = gp && gp.basic_quaternion;
  const frame = gp && gp.frame_reference;
  const local = gp && gp.local_source_transform;
  const posLabel = (p) =>
    p ? `${fixed3(p.lat)}, ${fixed3(p.lon)}, ${fixed3(p.h)}` : "—";
  writeDebugText("gp-ypr-pos", ypr ? posLabel(ypr.position) : "—");
  writeDebugText(
    "gp-ypr-ang",
    ypr && ypr.angles
      ? `${fixed3(ypr.angles.yaw)}, ${fixed3(ypr.angles.pitch)}, ${fixed3(ypr.angles.roll)}`
      : "—"
  );
  writeDebugText(
    "gp-quat",
    quat && quat.quaternion
      ? `${fixed3(quat.quaternion.x)}, ${fixed3(quat.quaternion.y)}, ${fixed3(quat.quaternion.z)}, ${fixed3(quat.quaternion.w)}`
      : "—"
  );
  writeDebugText("gp-outer", frame ? frame.outer_frame : "—");
  writeDebugText("gp-inner", frame ? frame.inner_frame : "—");
  writeDebugText(
    "gp-local",
    local ? `${vec3Label(local.position)} · yaw ${fixed3(local.rotation_y_radians)}` : "—"
  );
  // ogc_geopose_conformance is now a SCOPED object, not a bare
  // boolean. Surface the scoped truth precisely: the Basic SDUs are SCHEMA-VALID
  // (structural/data conformance) while georeferencing + full conformance stay false.
  const conf = gp ? gp.ogc_geopose_conformance : null;
  const schemaValid = conf && typeof conf === "object" ? conf.basic_sdu_schema_valid === true : undefined;
  writeDebugBool("gp-schema-valid", schemaValid);
  writeDebugBool("gp-georef", gp ? gp.georeferenced === true : undefined);
  // The scoped conformance line (not a plain true/false — it states the scope).
  writeDebugText(
    "gp-conf",
    conf && typeof conf === "object"
      ? "Basic-YPR/Quaternion SDU schema-valid ✓ · georeferenced:false · NOT full GeoPose conformance"
      : gp
      ? String(conf)
      : "—"
  );
  const gpConfEl = $("gp-conf");
  if (gpConfEl) {
    // Green only for the scoped-valid case; the wording carries the scope so the
    // green cannot be misread as "georeferenced" or "fully conformant".
    gpConfEl.classList.toggle("std-scoped-true", schemaValid === true);
  }
  document.body.setAttribute(
    "data-geopose-shaped",
    gp
      ? "basic-sdu-schema-valid:true:georeferenced:false:full-conformance:false:standards_conformance=false"
      : ""
  );
  document.body.setAttribute(
    "data-geopose-ypr-position",
    ypr && ypr.position ? `${ypr.position.lat},${ypr.position.lon},${ypr.position.h}` : ""
  );
}

const PHASE_LABEL = {
  [HANDOFF_PHASES.IDLE]: { text: "idle", cls: "" },
  [HANDOFF_PHASES.PORTAL_ACTIVE]: { text: "portal active", cls: "" },
  [HANDOFF_PHASES.DEPARTED]: { text: "departed (avatar hidden)", cls: "departed" },
  [HANDOFF_PHASES.WAITING]: { text: "waiting for arrival", cls: "waiting" },
  [HANDOFF_PHASES.ARRIVED]: { text: "arrived (avatar visible)", cls: "arrived" },
  // single continuous walk-through beat (no centering/
  // holding/disappearing labels — those phases no longer exist).
  [PORTAL_TRANSITION_PHASES.WALKTHROUGH]: { text: "walking through portal", cls: "" },
};

// onState (and therefore renderOverlay) fires on every
// debug-state poll tick, not just on phase transitions — so the DEPARTED/
// ARRIVED toast trigger below is guarded by lastToastPhase to fire once per
// phase-entry instead of restarting the toast's dismiss timer every tick.
let lastToastPhase = null;

function renderOverlay(phase, dbg) {
  const overlay = $("state-overlay");
  // Client scene loads replace #scene-mount wholesale. The overlay is an
  // intentionally empty legacy surface, so its absence during/after that
  // replacement is valid and must not turn state refreshes into page errors.
  if (!overlay) return;
  overlay.className = "state-overlay " + (PHASE_LABEL[phase]?.cls || "");
  if (isPlayer && connectionPresentation.state !== "live") {
    const failed = connectionPresentation.state !== "loading";
    const heading = connectionPresentation.state === "loading"
      ? "Opening your world"
      : connectionPresentation.state === "disconnected"
        ? "World connection unavailable"
        : connectionPresentation.state === "refused"
          ? "This world was refused"
          : "The world is temporarily unavailable";
    const recovery = connectionPresentation.recovery;
    const recoveryMarkup = recovery
      ? `<div class="player-first-frame-actions">
        <button class="primary" id="btn-connection-retry" data-testid="connection-retry" type="button"
          aria-label="${escapeHtml(recovery.aria_label || recovery.label)}">${escapeHtml(recovery.label)}</button>
        <span class="recovery-note">${escapeHtml(recovery.note)}</span>
      </div>`
      : connectionPresentation.state === "refused"
        ? `<div class="recovery-note" data-testid="connection-terminal-refusal">Retry is unavailable because this is a trust or policy refusal.</div>`
        : "";
    overlay.innerHTML = `<section class="player-first-frame" data-testid="player-connection-card"
      data-connection-state="${escapeHtml(connectionPresentation.state)}"
      data-failure-kind="${escapeHtml(connectionPresentation.failure_kind || "none")}"
      data-recoverable="${String(connectionPresentation.recoverable === true)}"
      data-current-runtime="${escapeHtml(connectionPresentation.current || "none")}"
      role="${failed ? "alert" : "status"}" aria-live="${failed ? "assertive" : "polite"}">
      <div class="eyebrow">${escapeHtml(CONNECTION_STATE_PRESENTATION[connectionPresentation.state].label)}</div>
      <h1>${escapeHtml(heading)}</h1>
      <p>${escapeHtml(connectionPresentation.detail)}</p>
      ${recoveryMarkup}
    </section>`;
    const retry = $("btn-connection-retry");
    if (retry && recovery) {
      retry.addEventListener("click", () => {
        if (recovery.kind === "return") {
          setConnectionPresentation(
            "live",
            recovery.success_detail || "The last verified world remains active.",
            { current: recovery.current || "verified-parent", recovery: null }
          );
        } else {
          location.reload();
        }
      });
    }
    return;
  }
  if (isPlayer && !playerOrientationDismissed) {
    const title = dbg && dbg.world_title
      ? dbg.world_title
      : adapter && adapter.world && adapter.world.title
        ? adapter.world.title
        : "the Open Spatial Lab";
    overlay.innerHTML = `<section class="player-first-frame" data-testid="player-first-frame"
      data-connection-state="live" role="region" aria-label="Player orientation">
      <div class="eyebrow">Live · ${escapeHtml(title)}</div>
      <h1>You’re in ${escapeHtml(title)}</h1>
      <p>Explore this world as the player, then walk through a lit portal to continue into the connected space.</p>
      <div class="player-first-frame-controls">W A S D to walk · drag to look · scroll to zoom · Shift to run</div>
      <div class="player-first-frame-actions">
        <button class="primary" id="btn-start-exploring" data-testid="start-exploring" type="button">Start exploring</button>
      </div>
    </section>`;
    const start = $("btn-start-exploring");
    if (start) {
      start.addEventListener("click", () => {
        playerOrientationDismissed = true;
        renderOverlay(phase, dbg);
      });
    }
    return;
  }
  // the observer START-STATE modal cards — the idle
  // "Location A"/"Location B" card and the "Waiting for arrival at …" card
  // that used to cover the server views until the avatar crossed — are
  // REMOVED entirely (no .state-card exists in those phases). The location
  // identity/phase stay visible in the header (#loc-title/#phase-pill) and
  // the debug rail; the transient crossing toasts are unchanged.
  //
  // the LAST remaining center-screen card — the
  // "Portal active" line — is now a one-shot toast below (interface requirement:
  // nothing in the middle of the screen, ever). #state-overlay therefore
  // renders NO card in any phase; the full notification-center/detail-window
  // conversion remains (retargeted as).
  //
  // the crossing is instant/seamless (no shrink, no dwell) —
  // the transient "Entering portal"/"Holding pose"/"Disappearing" center-screen
  // cards were already dropped; phases still feed #phase-pill via PHASE_LABEL.
  overlay.innerHTML = "";

  // "Portal active", "Crossing"/"Departed" and "Arrival received" are transient
  // EVENT notices, not steady-state — they render as auto-dismissing toasts.
  if (phase !== lastToastPhase) {
    lastToastPhase = phase;
    if (phase === HANDOFF_PHASES.PORTAL_ACTIVE) {
      showToast(
        "Portal active",
        "at traversal trigger — walk through to cross",
        "toast-departed"
      );
    }
    if (phase === HANDOFF_PHASES.DEPARTED) {
      showToast(
        isPlayer ? "Crossing" : "Departed",
        isPlayer
          ? "promoting target fabric to root — same context, no reload"
          : "exit intent POSTed · local avatar hidden",
        "toast-departed"
      );
    }
    if (phase === HANDOFF_PHASES.ARRIVED) {
      // surface the headline metric — the time it
      // took to get through the portal — plus whether the crossing promoted
      // warm prefetched destination data (no artificial delay either way).
      const resumeMs =
        dbg && dbg.crossing && Number.isFinite(Number(dbg.crossing.controls_resume_ms))
          ? Number(dbg.crossing.controls_resume_ms)
          : null;
      const prefetchProof =
        dbg && dbg.last_handoff_payload && dbg.last_handoff_payload.fabric_prefetch_proof
          ? dbg.last_handoff_payload.fabric_prefetch_proof
          : null;
      const prefetchText = prefetchProof
        ? prefetchProof.used
          ? "fabric prefetched"
          : "cold crossing"
        : null;
      // the destination branding that used to headline the
      // removed center-screen loading card now rides this toast. At
      // ARRIVED the active endpoint IS the destination, so its cached
      // metaverse.portal.* branding (destination-server-served, never
      // hardcoded) is read directly; markup-significant chars stripped because
      // showToast interpolates into innerHTML.
      const destContent = isPlayer ? destinationLoadingContent() : null;
      const destBrandEntry =
        destContent && destContent.content && destContent.content.pointers
          ? destContent.content.pointers["metaverse.portal.loadingBranding"]
          : null;
      const destTitle =
        destBrandEntry && destBrandEntry.value && destBrandEntry.value.world_title
          ? String(destBrandEntry.value.world_title).replace(/[<>&"]/g, "")
          : null;
      const arrivalHeadline = isPlayer
        ? ["ARRIVED", destTitle, resumeMs != null ? `${resumeMs} MS` : null].filter(Boolean).join(" · ")
        : "ARRIVAL RECEIVED";
      showToast(
        arrivalHeadline,
        isPlayer
          ? [prefetchText, "live crossing", "presence continues", "same context, no reload"]
              .filter(Boolean)
              .join(" · ")
          : "arrival applied locally · return portal active",
        "toast-arrived",
        { notificationId: latestNotificationIdByKind("portal_through_loading") }
      );
    }
  }
}

function renderEquipment(status, avatar) {
  const list = $("equipment-list");
  const summary = $("equipment-summary");
  if (!list || !summary) return;
  const items = avatar && Array.isArray(avatar.equippedItems) ? avatar.equippedItems : [];
  const resolved = status && Array.isArray(status.items) ? status.items : [];
  const validation = status && status.validation ? status.validation : null;
  summary.textContent = validation
    ? (validation.ok ? "schema PASS" : `schema FAIL: ${validation.errors.join("; ")}`)
    : (items.length ? "schema prepared" : "waiting for arrival packet");
  summary.className = validation && validation.ok ? "v boundary-ok" : "v";
  const html = items.length
    ? items.map((item) => {
        const r = resolved.find((entry) => entry.itemId === item.itemId);
        const fetchText = !r
          ? "fetch pending"
          : r.fetch_ok
            ? r.message
            : `${r.message} · visible fallback ${r.visible_fallback ? "ON" : "OFF"}`;
        const cls = r && r.fetch_ok === false ? "equipment-bad" : "equipment-ok";
        return `<div class="equipment-row ${cls}" data-reconcile-key="equipment:${escapeHtml(item.itemId)}:${escapeHtml(item.attachmentPoint)}">
          <div><b>${item.mode}</b> ${item.itemId}</div>
          <div>${item.attachmentPoint}</div>
          <div>${fetchText}</div>
        </div>`;
      }).join("")
    : `<div class="equipment-row" data-reconcile-key="equipment-empty">No equipment manifest on this view yet.</div>`;
  reconcileKeyedHtml(list, html);
}

function flagCell(el, val) {
  el.textContent = String(val);
  el.classList.toggle("true", val === true);
  el.classList.toggle("false", val === false);
}

function setConnectionPresentation(state, detail, failedPath = null) {
  if (!Object.prototype.hasOwnProperty.call(CONNECTION_STATE_PRESENTATION, state)) return;
  if (state === "error") state = "unavailable";
  const failure = failedPath && typeof failedPath === "object" ? failedPath : null;
  const path = typeof failedPath === "string" ? failedPath : failure && failure.path ? failure.path : null;
  const defaultRecovery = state === "disconnected" || state === "unavailable" || state === "error"
    ? {
        kind: "reload",
        label: "Reload & retry",
        aria_label: "Reload and retry this world",
        note: "Reloads this view because the live runtime boots as one coherent session.",
      }
    : null;
  const recovery = failure && Object.prototype.hasOwnProperty.call(failure, "recovery")
    ? failure.recovery
    : defaultRecovery;
  connectionPresentation = {
    state,
    detail: detail || CONNECTION_STATE_PRESENTATION[state].footer,
    failed_path: path,
    failure_kind: failure && failure.kind ? failure.kind : (state === "loading" || state === "live" ? null : state),
    source_state: failure && failure.source_state ? failure.source_state : null,
    current: failure && failure.current ? failure.current : (state === "live" ? "live-world" : "none"),
    recoverable: state !== "refused" && !!recovery,
    recovery: state === "refused" ? null : recovery,
  };
  document.body.setAttribute("data-connection-state", state);
  document.body.setAttribute("data-connection-recoverable", String(connectionPresentation.recoverable));
  document.body.setAttribute("data-connection-current", connectionPresentation.current);
  if (connectionPresentation.failure_kind) {
    document.body.setAttribute("data-connection-failure-kind", connectionPresentation.failure_kind);
  } else {
    document.body.removeAttribute("data-connection-failure-kind");
  }
  const header = $("connection-status");
  if (header) {
    header.className = `live-tag connection-${state}`;
    header.textContent = CONNECTION_STATE_PRESENTATION[state].label;
  }
  const footer = $("connection-footer-status");
  if (footer) {
    footer.innerHTML = `<span><span class="prov prov-${state}">${escapeHtml(state)}</span> ${escapeHtml(CONNECTION_STATE_PRESENTATION[state].footer)}</span>` +
      `<span>correlate by <b>handoff_id</b></span>`;
  }
  const provenance = $("connection-provenance");
  if (provenance) {
    provenance.className = `prov prov-${state}`;
    provenance.textContent = state;
  }
  const backend = $("live-backend");
  if (backend) {
    backend.textContent = state === "live" && adapter ? adapter.base : CONNECTION_STATE_PRESENTATION[state].footer;
    backend.style.color = state === "live" ? "var(--ok)" : state === "loading" ? "var(--warn)" : "var(--bad)";
  }
  const locationTitle = $("loc-title");
  if (locationTitle && isPlayer && (!adapter || !adapter.world)) {
    locationTitle.textContent = state === "loading" ? "Opening player world…" : "Player world unavailable";
  }
  renderOverlay(
    adapter && adapter.state ? adapter.state.phase : HANDOFF_PHASES.IDLE,
    adapter && adapter.world ? canonicalDebugState(adapter.debugState()) : null
  );
  semanticDestinationsController?.update();
}

function handleConnectionApiRequest(event) {
  const request = event.detail || {};
  if (connectionPresentation.state === "loading") return;
  if (
    request.ok &&
    (connectionPresentation.state === "disconnected" ||
      connectionPresentation.state === "unavailable" ||
      connectionPresentation.state === "error") &&
    connectionPresentation.failed_path &&
    request.path === connectionPresentation.failed_path
  ) {
    setConnectionPresentation("live", "The live world connection recovered.");
  } else if (!request.ok && Number(request.status) === 0) {
    setConnectionPresentation(
      "disconnected",
      "The live world stopped responding. Reload and retry when the local services are available.",
      request.path || null
    );
  } else if (!request.ok && Number(request.status) >= 500) {
    setConnectionPresentation(
      "error",
      `The live world returned HTTP ${request.status}. Reload and retry after the service recovers.`,
      { path: request.path || null, kind: "service_http", source_state: `http_${request.status}` }
    );
  }
}

function handleOffline() {
  setConnectionPresentation("disconnected", "This browser is offline. Reconnect, then reload and retry the current world.");
}

listenAtRoot(API_EVENTS, "wow-api-request", handleConnectionApiRequest);
listenAtRoot(window, "offline", handleOffline);

let adapter, scene, equipmentLayer, portalVisualAlignment, portalRenderController, avatarSelectorController, sceneRuntimeController, movementCameraController, semanticDestinationsController, storefrontShoppingController, boardingJourneyController, runtimeTweakController, demoTrajectoryTool;
const liveViewportState = {
  width: 0,
  height: 0,
  offsetLeft: 0,
  offsetTop: 0,
  pixelRatio: 1,
  epoch: 0,
  listenerCount: 0,
};
let liveViewportFrame = 0;
let liveViewportMounted = false;
let removePixelRatioListener = null;
const requestViewportFrame = window.requestAnimationFrame.bind(window);
const cancelViewportFrame = window.cancelAnimationFrame.bind(window);

function measureLiveViewport() {
  const visual = window.visualViewport;
  return {
    width: Math.max(1, Number((visual && visual.width) || window.innerWidth || document.documentElement.clientWidth || 1)),
    height: Math.max(1, Number((visual && visual.height) || window.innerHeight || document.documentElement.clientHeight || 1)),
    offsetLeft: Number((visual && visual.offsetLeft) || 0),
    offsetTop: Number((visual && visual.offsetTop) || 0),
    // the clamp ceiling is the shared boot lever, not
    // a literal. This mirror and the scene-runtime resize path must agree, or
    // the first window resize re-raises whatever this returns.
    pixelRatio: pixelRatioFor(window.devicePixelRatio),
  };
}

function liveViewportSnapshot() {
  const bounds = (element) => {
    if (!element) return null;
    const rectangle = element.getBoundingClientRect();
    return {
      left: Number(rectangle.left.toFixed(3)),
      top: Number(rectangle.top.toFixed(3)),
      width: Number(rectangle.width.toFixed(3)),
      height: Number(rectangle.height.toFixed(3)),
    };
  };
  return {
    ...liveViewportState,
    root: bounds(document.documentElement),
    body: bounds(document.body),
    app: bounds(appEl),
    scene_mount: bounds($("scene-mount")),
    page_scroll_width: document.documentElement.scrollWidth,
    page_scroll_height: document.documentElement.scrollHeight,
    scene: sceneRuntimeController ? sceneRuntimeController.viewportDebug() : null,
  };
}

function applyLiveViewport(force = false) {
  const next = measureLiveViewport();
  const changed = ["width", "height", "offsetLeft", "offsetTop", "pixelRatio"]
    .some((key) => Math.abs(next[key] - liveViewportState[key]) > 0.01);
  if (!changed && !force) return liveViewportSnapshot();
  Object.assign(liveViewportState, next, { epoch: liveViewportState.epoch + 1 });
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--osl-viewport-width", `${next.width}px`);
  rootStyle.setProperty("--osl-viewport-height", `${next.height}px`);
  rootStyle.setProperty("--osl-viewport-left", `${next.offsetLeft}px`);
  rootStyle.setProperty("--osl-viewport-top", `${next.offsetTop}px`);
  document.body.setAttribute("data-live-viewport-epoch", String(liveViewportState.epoch));
  sceneRuntimeController?.resize(next);
  equipmentLayer?.resize?.();
  for (const layer of peerAvatarLayers.values()) layer?.resize?.();
  movementCameraController?.applyPlayerCamera();
  return liveViewportSnapshot();
}

function scheduleLiveViewport() {
  if (liveViewportFrame) return;
  liveViewportFrame = requestViewportFrame(() => {
    liveViewportFrame = 0;
    applyLiveViewport();
  });
}

function armPixelRatioListener() {
  if (removePixelRatioListener) removePixelRatioListener();
  removePixelRatioListener = null;
  const createMediaQuery = window["match" + "Media"];
  if (typeof createMediaQuery !== "function") return;
  const query = createMediaQuery.call(window, `(resolution: ${Number(window.devicePixelRatio) || 1}dppx)`);
  const changed = () => {
    armPixelRatioListener();
    scheduleLiveViewport();
  };
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", changed, { once: true });
    removePixelRatioListener = () => query.removeEventListener("change", changed);
  } else if (typeof query.addListener === "function") {
    query.addListener(changed);
    removePixelRatioListener = () => query.removeListener(changed);
  }
}

function mountLiveViewportLifecycle() {
  if (liveViewportMounted) return false;
  liveViewportMounted = true;
  const visual = window.visualViewport;
  const sources = [
    [window, "resize"],
    [window, "orientationchange"],
    [visual, "resize"],
    [visual, "scroll"],
  ];
  for (const [target, type] of sources) {
    if (!target) continue;
    listenAtRoot(target, type, scheduleLiveViewport, { passive: true });
    liveViewportState.listenerCount += 1;
  }
  armPixelRatioListener();
  if (removePixelRatioListener) liveViewportState.listenerCount += 1;
  applyLiveViewport(true);
  return true;
}

portalRenderController = createPortalRenderController({
  THREE,
  isPlayer,
  getPortalHost: () => adapter ? {
    activeEndpointKey: adapterVisualRuntimeSnapshot()?.activeEndpointKey,
    previewEndpointKey: adapterVisualRuntimeSnapshot()?.previewEndpointKey,
    world: adapterVisualRuntimeSnapshot()?.world,
    demoReadAttachPoint: (key) => adapter.demoReadAttachPoint(key),
    demoReadPortalView: (key, resolution) => adapter.demoReadPortalView(key, resolution),
    demoMoveSceneObject: (key, id, position) => adapter.demoMoveSceneObject(key, id, position),
    demoMovePortal: (key, position) => adapter.demoMovePortal(key, position),
    demoReadRepublishRate: (key) => adapter.demoReadRepublishRate(key),
    demoSetRepublishRate: (key, milliseconds) => adapter.demoSetRepublishRate(key, milliseconds),
    applyHostedPortalPose: (position) => adapter.applyHostedPortalPose(position),
    applyHostedTargetPortalPose: (position) => adapter.applyHostedTargetPortalPose(position),
  } : null,
  getScene: () => scene,
  getServerViewMode: () => movementCameraController ? movementCameraController.serverViewMode() : null,
  alignPortalVisualToTrigger,
  setPortalVisualAlignment: (alignment) => { portalVisualAlignment = alignment; },
  setLayerRecursive,
  childFabricLayer: CHILD_FABRIC_LAYER,
  lookup: $,
  documentTarget: document,
  windowTarget: window,
  nowMs: () => performance.now(),
  nowIso: () => new Date().toISOString(),
  logLine,
  writeDebugText,
  vec3Label,
  fixed3,
  isTypingTarget,
});

function destinationLoadingContent() {
  if (!adapter || !adapter.activeEndpointKey) return null;
  const key = adapter.activeEndpointKey;
  const cached = portalRenderController?.getCachedAttachPoint(key);
  const content = cached ? featureExtractPortalLoadingContent(cached) : null;
  if (!content) return null;
  const base = typeof adapter.demoProxyBase === "function" ? adapter.demoProxyBase(key) : "";
  return { key, base, content };
}

panelTruthChromeController = assertPanelTruthChromeControllerContract(createPanelTruthChromeController({
  lookup: $,
  documentTarget: document,
  windowTarget: window,
  body: document.body,
  appRoot: appEl,
  apiEvents: API_EVENTS,
  isPlayer,
  reconcileKeyedHtml,
  writeDebugText,
  writeDebugBool,
  logLine,
  nowMs: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (frame) => cancelAnimationFrame(frame),
  storage: typeof sessionStorage !== "undefined" ? sessionStorage : null,
  MutationObserverClass: typeof MutationObserver !== "undefined" ? MutationObserver : null,
  ResizeObserverClass: null,
  getCapabilities: () => adapter ? {
    apiPanelInfo: () => adapter.apiPanelInfo(),
    wowResolved: () => adapter.wowResolved(),
    claimBoundary: () => adapter.claimBoundary(),
    debugState: () => adapter.world ? adapter.debugState() : null,
    apiFetchEndpoint: (kind, id) => adapter.apiFetchEndpoint(kind, id),
    presenterExitIntent: () => adapter.presenterExitIntent(),
    presenterDeliverArrival: (packet, settings) => adapter.presenterDeliverArrival(packet, settings),
    verifyViewMatchesCamera: () => adapter.verifyViewMatchesCamera(),
    wowLocalWalk: !!adapter._wowLocalWalk,
    setRp1FailClosedDemoMode: (mode) => adapter.setRp1FailClosedDemoMode(mode),
    rendererKind: scene && scene.rendererKind ? scene.rendererKind : "three.js",
  } : {
    rendererKind: scene && scene.rendererKind ? scene.rendererKind : "three.js",
  },
  resizeSceneSurfaces: () => {
    try { if (sceneRuntimeController) sceneRuntimeController.resize(); } catch {}
    try { if (equipmentLayer && typeof equipmentLayer.resize === "function") equipmentLayer.resize(); } catch {}
    for (const layer of peerAvatarLayers.values()) {
      try { if (typeof layer.resize === "function") layer.resize(); } catch {}
    }
  },
  wirePortalSettingsModal: () => portalRenderController?.wireSettingsModal(),
  buildAndSignManifest: umBuildAndSignManifest,
  verifyManifestSignature: umVerifyManifestSignature,
  makeAvatarDefinition: umMakeAvatarDefinition,
  makeLoadingPointer: umMakeLoadingPointer,
  buildLoadingPointersForManifest: featureBuildLoadingPointersForManifest,
  getDestinationLoadingContent: destinationLoadingContent,
}));

// Compatibility delegate retained for the accepted Patch 1 frame-order proof.
function refreshWowViewMatch(now) {
  return panelTruthChromeController.refreshViewMatch(now);
}

// co-presence: one AvatarEquipmentLayer per tracked
// player co-present in this world (client_id -> layer). Player views use this
// for OTHER players; observer/server views use it for every player in their
// current location. Layers are keyed and disposed when a peer leaves or goes
// silent, so there is never a duplicate/ghost/self avatar.
const peerAvatarLayers = new Map();

// every render-loop consumer reads the same source or
// destination projection. Destination transport may stage on LiveAdapter, but
// the scene runtime, camera loop, debug/HUD projection, and evidence driver do
// not observe it until the synchronous visual commit edge.
function adapterVisualRuntimeSnapshot() {
  return adapter && typeof adapter.visualRuntimeSnapshot === "function"
    ? adapter.visualRuntimeSnapshot()
    : adapter
      ? {
          staged: false,
          state: adapter.state,
          world: adapter.world,
          base: adapter.base,
          activeEndpointKey: adapter.activeEndpointKey,
          previewEndpointKey: adapter.previewEndpointKey,
        }
      : null;
}

function adapterVisualDebugState() {
  return adapter && typeof adapter.visualDebugState === "function"
    ? adapter.visualDebugState()
    : adapter
      ? adapter.debugState()
      : null;
}

// BEGIN — one scene, one depth buffer.
// Every scene-mount avatar layer (the local player's AND each peer's) is parented
// into the WORLD's own scene so all avatars and all world geometry share ONE depth
// buffer. Before this, each layer owned a stacked transparent canvas and CSS DOM
// order — not distance — decided which avatar was painted on top (proved the
// FURTHER avatar wins the overlap regardless of depth). The avatar-selector preview
// keeps the old standalone mode: an isolated widget canvas is the job that mode is
// for. `?avatar_compositing=stacked` restores the pre-060 stacked-canvas wiring —
// it exists as the NEGATIVE-PROOF arm (the acceptance proof must go red on it) and
// as an escape hatch; it is not a supported rendering mode.
const AVATAR_COMPOSITING_MODE = (() => {
  try {
    return new URLSearchParams(window.location.search).get("avatar_compositing") === "stacked"
      ? "stacked"
      : "shared";
  } catch (e) {
    return "shared";
  }
})();

sceneRuntimeController = createSceneRuntimeController({
  THREE,
  SceneClass: Scene,
  AvatarLayerClass: AvatarEquipmentLayer,
  buildWowScene,
  mountAirportTerminalContent,
  mountWowSceneAssets,
  mountCanonicalWorldContent,
  loadGltf: loadGltfSceneAsset,
  cloneScene: cloneGltfSceneAsset,
  airportSceneContract,
  isPlayer,
  role,
  stageMode: stageParam,
  sharedAvatarCompositing: AVATAR_COMPOSITING_MODE !== "stacked",
  motionPreference,
  getMount: () => $("scene-mount"),
  documentTarget: document,
  windowTarget: window,
  locationHref: location.href,
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  getRuntime: () => {
    const visual = adapterVisualRuntimeSnapshot();
    return adapter && visual ? {
    world: visual.world,
    base: visual.base,
    phase: () => visual.state.phase,
    avatar: () => visual.state.avatar,
    debugState: () => adapterVisualDebugState(),
    rawDebugState: () => adapter.debugState(),
    isHandoffInFlight: () => adapter._portalTraversalController?.inFlight?.() === true,
    controlledPlayerId: () => adapter.controlledIdentity().player_id,
    childFabricManifest: () => adapter.childFabricManifest(),
    setChildFabricRenderState: (state) => adapter.setChildFabricRenderState(state),
    markChildFabricPreviewFrame: () => adapter.markChildFabricPreviewFrame(),
    wowResolved: () => adapter.wowResolved(),
    resolveClientSceneLoad: (target) => adapter.resolveClientSceneLoad(target),
    resolvePortalDestinationContent: (entry) => adapter.resolvePortalDestinationContent(entry),
    enterClientSceneLoad: (payload) => adapter.enterClientSceneLoad(payload),
    returnFromClientSceneLoad: (options) => adapter.returnFromClientSceneLoad(options),
    beginVisualTransition: (metadata) => adapter.beginVisualTransition(metadata),
    commitVisualTransition: (options) => adapter.commitVisualTransition(options),
    abortVisualTransition: (options) => adapter.abortVisualTransition(options),
  } : null;
  },
  getAvatarLayers: () => ({ local: equipmentLayer, peers: peerAvatarLayers.values() }),
  syncPeerAvatars: (debug) => syncPeerAvatars(debug),
  sceneRoleForDebug: activeSceneRole,
  alignPortalVisual: alignPortalVisualToTrigger,
  portalKey: appPortalKey,
  setupNavigatorRender: () => setupWorldNavigatorRender(),
  onSceneChanged: (next) => {
    scene = next;
    movementCameraController?.refreshSceneHost();
    movementCameraController?.applyPlayerCamera();
    if (window.__assembly) {
      window.__assembly.scene = next;
      window.__assembly.rendererKind = next ? next.rendererKind : null;
    }
  },
  onPortalAlignment: (alignment) => { portalVisualAlignment = alignment; },
  seedOrbitCamera: (seed) => movementCameraController?.seedOrbitCamera(seed),
  applyPlayerCamera: () => movementCameraController?.applyPlayerCamera(),
  logLine,
  showToast,
  vec3Label,
});

movementCameraController = createMovementCameraController({
  // Compatibility anchor: spatialPortalPreviews.renderActive(); is controller-owned
  // by SceneRuntime and is invoked through renderPortalPreviews in the shared frame.
  THREE,
  isPlayer,
  role,
  windowTarget: window,
  documentTarget: document,
  lookup: $,
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  now: () => performance.now(),
  getRuntime: () => {
    const visual = adapterVisualRuntimeSnapshot();
    return adapter && visual ? {
    state: visual.state,
    world: visual.world,
    stepAvatar: (input, dt) => adapter.stepAvatar(input, dt),
    debugState: () => adapterVisualDebugState(),
    shouldAutoHandoff: () => adapter.shouldAutoHandoff(),
    markAutoHandoffObserved: () => adapter.markAutoHandoffObserved(),
    broadcastPlayerPose: (options) => adapter.broadcastPlayerPose(options),
  } : null;
  },
  sceneRuntime: sceneRuntimeController,
  getAvatarLayers: () => ({ local: equipmentLayer, peers: peerAvatarLayers.values() }),
  resolveClientSceneLoadTraversal,
  persistPlayerSession: (force) => persistPlayerLocationState(force),
  refreshViewMatch: (nowMs) => refreshWowViewMatch(nowMs),
  renderOrientation: () => {
    // Compatibility anchor: CONTROL_KEY_MAP[ev.code] && !playerOrientationDismissed
    // is now split between the movement controller's key gate and this projection.
    // Escape shares the same singleton listener, but may dismiss only the live
    // orientation card — never loading, refusal, or failure presentation.
    const orientation = $("state-overlay")?.querySelector(
      '[data-testid="player-first-frame"][data-connection-state="live"]'
    );
    if (!playerOrientationDismissed && orientation) {
      playerOrientationDismissed = true;
      renderOverlay(
        adapterVisualRuntimeSnapshot()?.state?.phase || HANDOFF_PHASES.IDLE,
        adapterVisualRuntimeSnapshot()?.world ? canonicalDebugState(adapterVisualDebugState()) : null,
      );
    }
  },
  refreshDebugProjection: () => {
    if (!adapter) return;
    const canonical = canonicalDebugState(adapterVisualDebugState());
    updateClientDebugCard(canonical);
    mirrorDataset(canonical);
  },
  updateMovementProjection: (debug, movement) => updateMovementDebug(debug, movement),
  applyPortalOcclusion: (position, target, mode) => updatePortalApertureOcclusion(position, target, mode),
  logLine,
  showToast,
  isTypingTarget,
  motionPreference,
});

semanticDestinationsController = createSemanticDestinationsController({
  lookup: $,
  createElement: (tagName) => document.createElement(tagName),
  documentTarget: document,
  eventTarget: document,
  getSnapshot: () => ({
    world: adapterVisualRuntimeSnapshot()?.world || null,
    debug: adapterVisualRuntimeSnapshot()?.world ? adapterVisualDebugState() : null,
    connectionState: connectionPresentation.state,
    isPlayer,
  }),
  activateFocusedPortal: () => adapter.activatePortal(),
  isTypingTarget,
  logger: logLine,
});

storefrontShoppingController = createAirportStorefrontInteractionController({
  isPlayer,
  documentTarget: document,
  lookup: $,
  createElement: (tagName) => document.createElement(tagName),
  releaseMovement: () => movementCameraController.releaseControls(),
  focusFallback: () => $("scene-mount"),
  showToast,
  logger: logLine,
  isTypingTarget,
});

boardingJourneyController = createAirportBoardingJourneyController({
  isPlayer,
  documentTarget: document,
  lookup: $,
  releaseMovement: () => movementCameraController.releaseControls(),
  focusFallback: () => $("scene-mount"),
  showToast,
  publishNotification: publishNotificationRecord,
  logger: logLine,
  isTypingTarget,
  nowIso: () => new Date().toISOString(),
});

/** The host world internals a shared-scene avatar layer parents into, or null when
 *  the world cannot host one (canvas2d degrade, or the stacked negative arm) — a
 *  null host makes AvatarEquipmentLayer fall back to its own-canvas overlay mode. */
function avatarLayerHost() {
  return sceneRuntimeController.avatarHost();
}
// END
const PEER_AVATAR_MIN_PLAYER_VIEW_SEPARATION_M = 0.72;
const PEER_AVATAR_OVERLAP_DISTANCE_M = 0.48;

function playerViewSeparatedPeerAvatar(peerAvatar, peerIndex) {
  if (!isPlayer || !adapter || !adapter.state || !adapter.state.avatar) return peerAvatar;
  if (!Array.isArray(peerAvatar.position)) return peerAvatar;
  const local = adapter.state.avatar;
  if (!Array.isArray(local.position)) return peerAvatar;

  const localX = Number(local.position[0]) || 0;
  const localZ = Number(local.position[2]) || 0;
  const peerX = Number(peerAvatar.position[0]) || 0;
  const peerZ = Number(peerAvatar.position[2]) || 0;
  const dx = peerX - localX;
  const dz = peerZ - localZ;
  const distance = Math.hypot(dx, dz);
  if (distance >= PEER_AVATAR_OVERLAP_DISTANCE_M) return peerAvatar;

  let ux = 0;
  let uz = 0;
  if (distance > 0.001) {
    ux = dx / distance;
    uz = dz / distance;
  } else {
    const side = peerIndex % 2 === 0 ? 1 : -1;
    const yaw = Number(local.rotation_y) || 0;
    ux = Math.cos(yaw) * side;
    uz = -Math.sin(yaw) * side;
  }

  const position = peerAvatar.position.slice(0, 3);
  position[0] = localX + ux * PEER_AVATAR_MIN_PLAYER_VIEW_SEPARATION_M;
  position[2] = localZ + uz * PEER_AVATAR_MIN_PLAYER_VIEW_SEPARATION_M;
  return {
    ...peerAvatar,
    position,
    visual_separation: {
      applied: true,
      reason: "same_spawn_player_view_overlap",
      original_position: peerAvatar.position.slice(0, 3),
      rendered_position: position.slice(0, 3),
      distance_before_m: Number(distance.toFixed(4)),
      min_separation_m: PEER_AVATAR_MIN_PLAYER_VIEW_SEPARATION_M,
    },
  };
}

avatarSelectorController = createAvatarSelectorController({
  isPlayer,
  role,
  variants: AVATAR_VARIANTS,
  inventorySlots,
  equipmentCatalog,
  validateEquippedItems,
  resolveEquipmentItems,
  // The canonical value owns the visible label and accessible action.
  // NO_EQUIPMENT_CHOICE.label / NO_EQUIPMENT_CHOICE.ariaLabel remain the
  // source values consumed by the controller.
  noEquipmentChoice: NO_EQUIPMENT_CHOICE,
  applyNoEquipmentChoice: (items) => applyNoEquipmentChoice(items),
  createPreviewLayer: (mount, previewRole, world) =>
    new AvatarEquipmentLayer(mount, previewRole, world, { motionPreference }),
  getRuntime: () => adapter
    ? {
        avatar: adapter.state ? adapter.state.avatar : null,
        world: adapter.world,
        setAvatarVariant: (variant) => adapter.setAvatarVariant(variant),
        setPreferredHeight: (height) => adapter.setPreferredHeight(height),
        applyEquipment: async (items, resolveStatus) => {
          const avatar = adapter.state ? adapter.state.avatar : null;
          if (!avatar) return { ok: false, error: "no embodied avatar" };
          avatar.equippedItems = items;
          adapter.state.equipment_status = await resolveStatus(items);
          if (typeof adapter._maybeBroadcastPlayerPose === "function") {
            adapter._maybeBroadcastPlayerPose({ force: true });
          }
          if (typeof adapter._emit === "function") adapter._emit();
          return { ok: true };
        },
      }
    : null,
  lookup: $,
  documentTarget: document,
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  logger: logLine,
  escapeHtml,
  writeDebugText,
  fixed3,
  yawQuaternion,
  isTypingTarget,
});

// Retain the meeting-critical named shell seam as a composition-only delegate;
// the controller remains the sole state and behavior owner.
const avatarSelectorRemoveAllEquipment = () => avatarSelectorController.removeAllEquipment();

function disposeApplication() {
  if (applicationDisposed) return;
  applicationDisposed = true;
  window.removeEventListener("pagehide", disposeApplication);
  // belt-and-suspenders session leave on unload: fire the
  // presence depart beacon via the adapter and stop the heartbeat, so departure
  // never depends solely on the presence controller's pagehide listener. Both
  // are idempotent (the server depart is idempotent + tombstoned); the server
  // TTL remains the final backstop for a dropped beacon. Best-effort — never
  // throws into the unload teardown.
  try { adapter?.stopPresenceHeartbeat?.(); } catch {}
  try { adapter?.departPresence?.({ beacon: true, reason: "pagehide" }); } catch {}
  if (liveViewportFrame) cancelViewportFrame(liveViewportFrame);
  liveViewportFrame = 0;
  if (removePixelRatioListener) removePixelRatioListener();
  removePixelRatioListener = null;
  for (const remove of rootListenerRemovers.splice(0).reverse()) {
    try { remove(); } catch {}
  }
  for (const controller of [
    movementCameraController,
    avatarSelectorController,
    storefrontShoppingController,
    boardingJourneyController,
    portalRenderController,
    semanticDestinationsController,
    runtimeTweakController,
    demoTrajectoryTool,
    panelTruthChromeController,
    notificationToastController,
  ]) {
    try { controller?.dispose(); } catch {}
  }
  panelTruthChromeController = null;
  storefrontShoppingController = null;
  boardingJourneyController = null;
  runtimeTweakController = null;
  demoTrajectoryTool = null;
  for (const layer of peerAvatarLayers.values()) {
    try { layer.dispose(); } catch {}
  }
  peerAvatarLayers.clear();
  motionPreference.dispose();
  try { equipmentLayer?.dispose(); } catch {}
  equipmentLayer = null;
  try { sceneRuntimeController?.dispose(); } catch {}
  scene = null;
  if (window.__assembly) {
    window.__assembly.ready = false;
    window.__assembly.disposed = true;
  }
  document.body.removeAttribute("data-assembly-ready");
}

function yawQuaternion(yaw) {
  const half = (Number(yaw) || 0) / 2;
  return [0, Number(Math.sin(half).toFixed(6)), 0, Number(Math.cos(half).toFixed(6))];
}

function roundedVec3(value) {
  return Array.isArray(value) ? value.slice(0, 3).map((entry) => Number((Number(entry) || 0).toFixed(3))) : [0, 0, 0];
}

function activeSceneRole(dbg) {
  if (!isPlayer) return role;
  const active = dbg && dbg.active ? dbg.active : {};
  return active.endpoint_key === "b" ? "target" : "source";
}

/* Patch 5: the portal-render proof/editor implementation now lives in
 * portal-render-controller.mjs. app.js retains only construction and
 * compatibility-surface wiring for that controller. */

/* ---------------- avatar visual grounding ---------------
 * The adapter's avatar y is the PHYSICS height (0 on the floor, >0 mid-jump);
 * the VISUAL model floated above the floor because the VRM bind sole and the
 * retargeted locomotion's re-centered hips both sit above the rig origin.
 * Fix: measure, per rendered frame, where the model's sole actually is and
 * offset the model INSIDE the rig so the feet touch the rig origin plane —
 * measured from the model's own geometry + humanoid foot bones, so it holds
 * for ANY avatar size/shape. Runs in every
 * view that renders the avatar (player + both observer mirrors). Adapter
 * state, avatar transforms, and all e2e-visible positions are untouched.
 */
function equipmentDebugFor(dbg) {
  const visual = equipmentLayer ? equipmentLayer.debugState() : null;
  const av = dbg && dbg.avatar;
  const items = av && Array.isArray(av.equippedItems) ? av.equippedItems : [];
  const held = visual ? visual.has_held_item === true : items.some((item) => item.mode === "held");
  const worn = visual ? visual.has_worn_item === true : items.some((item) => item.mode === "worn");
  return {
    equipped_count: items.length,
    held_item_visible: held,
    worn_item_visible: worn,
    items,
  };
}

function previewSourceCameraLabel(preview) {
  const rel = preview && preview.source_camera_relative_to_portal;
  const local = rel && rel.local_position;
  const forward = rel && rel.local_forward;
  return local
    ? `local=${fixed3(local.x)},${fixed3(local.y)},${fixed3(local.z)} f=${fixed3(forward && forward.x)},${fixed3(forward && forward.y)},${fixed3(forward && forward.z)}`
    : "—";
}

function previewTargetCameraLabel(preview) {
  const target = preview && preview.target_preview_camera_transform;
  return target && Array.isArray(target.position)
    ? `${vec3Label(target.position)} yaw=${fixed3(target.rotation_y)}`
    : "—";
}

function canonicalDebugState(raw) {
  const dbg = raw || (adapter ? adapter.debugState() : {});
  const controls = dbg.controls || {};
  const av = dbg.avatar;
  const equipment = equipmentDebugFor(dbg);
  const camera = isPlayer ? movementCameraController.updatePlayerCamera(dbg) : null;
  const preview =
    isPlayer && adapter && typeof adapter.updatePreviewProjection === "function"
      ? adapter.updatePreviewProjection(camera)
      : dbg.preview;
  const visual = equipmentLayer ? equipmentLayer.debugState() : null;
  const controllerMovement = movementCameraController.movementDebug();
  const movementKeys = controllerMovement.keys === "none" ? [] : controllerMovement.keys.split(" ");
  const transitionPhase =
    controls.portal_transition_phase && controls.portal_transition_phase !== "none"
      ? controls.portal_transition_phase
      : dbg.phase === HANDOFF_PHASES.DEPARTED
        ? "source_exit_committed"
        : "none";
  return {
    ...dbg,
    renderer_kind: scene ? scene.rendererKind : null,
    client_mode: dbg.client_mode || (isPlayer ? "player" : "observer"),
    preview,
    camera,
    avatar: av
      ? {
          ...av,
          position: roundedVec3(av.position),
          rotation_y: Number((Number(av.rotation_y) || 0).toFixed(6)),
          orientation: av.orientation || yawQuaternion(av.rotation_y),
          visible: true,
          locomotion_state: av.locomotion || controls,
          equippedItems: Array.isArray(av.equippedItems) ? av.equippedItems : [],
        }
      : null,
    movement: {
      keys_down: movementKeys,
      last_key_event: controllerMovement.last_key_event,
      last_planar_delta: roundedVec3(controls.last_planar_delta || controllerMovement.last_delta),
      movement_direction: controls.movement_direction || "none",
      movement_mode: controls.movement_mode || (controls.moving ? "walk" : "idle"),
      run_mode: controls.run_mode === true,
      speed_mps: Number(controls.speed_mps || 0),
      facing_semantics: controls.facing_semantics || "still",
      grounded: controls.grounded !== false,
      jump_height_m: Number(controls.jump_height_m || 0),
      controls_enabled: controls.enabled === true,
    },
    portal: {
      nearest_portal_id: controls.portal_frame_id || null,
      source_portal_id: controls.portal_frame_id || null,
      target_portal_id: controls.portal_linked_target_portal_id || null,
      portal_frame: controls.portal_frame || null,
      target_portal_frame: controls.portal_target_frame || null,
      portal_local_coordinates: controls.portal_local_coordinates || null,
      portal_signed_plane_distance_m: controls.portal_signed_plane_distance_m ?? null,
      inside_oval_aperture: controls.inside_oval_aperture === true,
      inside_trigger_volume: controls.inside_trigger_volume === true,
      portal_crossing_direction: controls.portal_crossing_direction || "unknown",
      portal_trigger_rearmed: controls.portal_trigger_rearmed === true,
      portal_handshake_ready: controls.portal_handshake_ready === true || controls.return_handshake_ready === true,
      portal_ready_blocker: controls.portal_ready_blocker || null,
      mapped_exit_transform: controls.mapped_exit_transform || null,
      mapped_exit_yaw: controls.mapped_exit_yaw ?? null,
    },
    transition: {
      phase: transitionPhase,
      phase_history: Array.isArray(controls.portal_transition_phase_history)
        ? controls.portal_transition_phase_history
        : [],
      elapsed_s: Number(controls.portal_transition_elapsed_s || 0),
      handoff_id: dbg.handoff_id || null,
      source_exit_accepted:
        (dbg.phase === HANDOFF_PHASES.DEPARTED && !!dbg.handoff_id) ||
        !!(dbg.crossing && dbg.crossing.server_notifications?.exit_intent?.accepted === true),
      target_arrival_accepted:
        (dbg.phase === HANDOFF_PHASES.ARRIVED && !!dbg.handoff_id) ||
        !!(dbg.crossing && dbg.crossing.server_notifications?.arrival?.accepted === true),
      // REAL value from the crossing record (was hardcoded false).
      active_endpoint_switched: !!(dbg.crossing && dbg.crossing.active_endpoint_switched === true),
      mapped_target_pose: controls.mapped_exit_transform || null,
    },
    handoff: {
      handoff_id: dbg.handoff_id || null,
      direction: dbg.last_handoff_direction || `${dbg.active?.location_id || dbg.location_id}->${preview?.location_id || "unknown"}`,
      profile_version: "msf.player-view-handoff.v0.1",
      last_payload: dbg.last_handoff_payload || null,
    },
    equipment,
    observer_correlation: {
      source_observer_handoff_id: null,
      target_observer_handoff_id: null,
      source_visible_avatar_count: role === "source" ? dbg.visibility?.local_visible_avatar_count ?? null : null,
      target_visible_avatar_count: role === "target" ? dbg.visibility?.local_visible_avatar_count ?? null : null,
      player_visible_avatar_count: isPlayer ? dbg.visibility?.local_visible_avatar_count ?? null : null,
      one_visible_avatar_across_three_surfaces: dbg.visibility?.one_avatar_visible_invariant === true,
    },
    proof_boundary: dbg.proof_boundary || {
      application_level_handoff: true,
      native_teleportxr_teleport: false,
      first_party_teleportxr_browser_rendering: false,
      standards_conformance: false,
      // SCOPED true (v0.1-baseline via the UM conformance runner) — this
      // fallback matches the live proof_boundary in live-adapter.js so it never understates
      // the (now proven) scoped-true. Single source of truth = UM_CONFORMANCE.
      um_conformance: { ...UM_CONFORMANCE },
      // HONEST FALSE — IWPS-SHAPED, NOT IWPS-CONFORMANT. The
      // "scoped true" shipped was an overclaim and is removed.
      iwps_conformance: { ...IWPS_CONFORMANCE },
      web_of_worlds_conformance: false,
      spatial_fabric_conformance: false,
    },
    // which portal fill surfaces are being suppressed
    // because they stand between the camera and the player (the
    // post-crossing opaque panel), with the signed plane distances behind it.
    portal_aperture_occlusion: movementCameraController.portalOcclusionState(),
    camera_wall_occlusion: movementCameraController.cameraWallOcclusionState(),
    portal_visual_alignment: portalVisualAlignment,
    equipment_visual: visual,
  };
}

function updateClientDebugCard(debug) {
  writeDebugText("c-mode", debug.client_mode || "—");
  writeDebugText("c-active", debug.active ? `${debug.active.endpoint_key} ${debug.active.location_id}` : "—");
  writeDebugText(
    "c-preview",
    debug.preview
      ? `${debug.preview.state} ${debug.preview.location_id || ""} ${debug.preview.source_type || ""} fresh=${debug.preview.freshness_ms ?? "—"}ms`
      : "—"
  );
  writeDebugText(
    "c-marker",
    debug.player_context_marker ? debug.player_context_marker.marker_id : "—"
  );
  writeDebugText(
    "c-camera",
    debug.camera ? `${debug.camera.mode} d=${debug.camera.follow_distance_m} h=${debug.camera.follow_height_m}` : "observer"
  );
  writeDebugText(
    "c-validation",
    debug.proof_boundary
      ? `native=${debug.proof_boundary.native_teleportxr_teleport} std=${debug.proof_boundary.standards_conformance}`
      : "—"
  );
  updatePreviewDebugCard(debug);
  updateNavigatorDebugCard(debug);
}

function updateNavigatorDebugCard(debug) {
  const nav = debug && debug.navigator ? debug.navigator : null;
  writeDebugText("n-context", nav ? nav.context_id || "—" : "—");
  writeDebugBool("n-single", nav ? nav.single_context === true : null);
  writeDebugText("n-status", nav ? nav.status || "—" : "—");
  writeDebugText(
    "n-root",
    nav && nav.root_fabric
      ? `${nav.root_fabric.container || nav.root_fabric.url || "—"} · ${nav.root_fabric.status || "—"}`
      : "—"
  );
  writeDebugText(
    "n-child",
    nav && nav.child_fabric
      ? `${nav.child_fabric.container || nav.child_fabric.url || "—"} · ${nav.child_fabric.status || "—"}`
      : "—"
  );
  writeDebugText(
    "n-fabrics",
    nav ? `${nav.fabrics_loaded_count || 0} in one context: ${(nav.fabrics_loaded || []).join(", ") || "—"}` : "—"
  );
  writeDebugText(
    "n-portal-node",
    nav && nav.portal_attachment
      ? `${nav.portal_attachment.node_id || "?"} bSubtype=${nav.portal_attachment.bSubtype} → ${
          nav.portal_attachment.sReference || "—"
        }`
      : "—"
  );
  writeDebugText(
    "n-spawn",
    nav && nav.spawn ? `${nav.spawn.source}${nav.spawn.applied ? "" : " (not applied)"}` : "—"
  );
  writeDebugText(
    "n-child-render",
    nav && nav.child_render
      ? nav.child_render.active
        ? `active · ${nav.child_render.surface || "—"} · frames=${nav.child_render.frame_count || 0}`
        : `inactive · ${nav.child_render.reason || "—"}`
      : "—"
  );
  writeDebugText(
    "n-trust",
    nav && nav.root_fabric && nav.root_fabric.status === "loaded"
      ? `${nav.root_fabric.format || "plain-json"} · ${nav.root_fabric.signed ? "signed" : "UNSIGNED (labeled)"}`
      : "—"
  );
  const crossing = debug && debug.crossing ? debug.crossing : null;
  writeDebugText(
    "n-promotion",
    crossing && crossing.fabric_promotion
      ? `${crossing.fabric_promotion.demoted_root_container || "?"} → ${
          crossing.fabric_promotion.promoted_root_container || "?"
        } · ${crossing.phase}`
      : nav && nav.promotion_count
        ? `promotions=${nav.promotion_count}`
        : "none"
  );
  const marker = debug && debug.player_context_marker ? debug.player_context_marker : null;
  writeDebugBool(
    "n-marker-crossing",
    marker && typeof marker.same_marker_after_crossing === "boolean"
      ? marker.same_marker_after_crossing
      : null
  );
}

function updatePreviewDebugCard(debug) {
  const preview = debug && debug.preview ? debug.preview : null;
  writeDebugText("pr-source", preview ? preview.source_type || "none" : "—");
  writeDebugBool("pr-readonly", preview ? preview.readonly === true : null);
  writeDebugText(
    "pr-target",
    preview ? `${preview.location_id || "—"} · ${preview.target_portal_id || "—"}` : "—"
  );
  writeDebugText("pr-freshness", preview && preview.freshness_ms !== null ? `${Math.round(preview.freshness_ms)} ms` : "—");
  writeDebugText("pr-fallback", preview ? preview.fallback_reason || "—" : "—");
  writeDebugText(
    "pr-arrivals",
    preview
      ? `${preview.target_arrival_count_before_preview ?? "—"} → ${preview.target_arrival_count_current ?? "—"}`
      : "—"
  );
  writeDebugBool("pr-presence", preview ? preview.target_avatar_presence_created === true : null);
  writeDebugText("pr-mutations", preview ? String(preview.target_mutation_count_during_preview ?? "—") : "—");
  writeDebugText("pr-source-camera", previewSourceCameraLabel(preview));
  writeDebugText("pr-target-camera", previewTargetCameraLabel(preview));
  writeDebugText("pr-projection", preview ? preview.projection_frame_source || "—" : "—");
}

function mirrorDataset(debug) {
  const body = document.body;
  const nav = debug.navigator || null;
  body.setAttribute("data-role", debug.role || role);
  body.setAttribute("data-client-mode", debug.client_mode || "");
  body.setAttribute("data-player-context-marker", debug.player_context_marker ? debug.player_context_marker.marker_id : "");
  body.setAttribute("data-player-context-current-href", debug.player_context_marker ? debug.player_context_marker.current_href : "");
  body.setAttribute("data-navigator-context-id", nav ? nav.context_id || "" : "");
  body.setAttribute("data-navigator-status", nav ? nav.status || "" : "");
  body.setAttribute("data-navigator-single-context", String(!!(nav && nav.single_context === true)));
  body.setAttribute("data-navigator-fabrics-loaded", nav ? (nav.fabrics_loaded || []).join(",") : "");
  body.setAttribute("data-navigator-fabrics-loaded-count", nav ? String(nav.fabrics_loaded_count || 0) : "");
  body.setAttribute("data-navigator-root-fabric-url", nav && nav.root_fabric ? nav.root_fabric.url || "" : "");
  body.setAttribute("data-navigator-child-fabric-url", nav && nav.child_fabric ? nav.child_fabric.url || "" : "");
  body.setAttribute(
    "data-navigator-portal-attachment-node",
    nav && nav.portal_attachment
      ? `${nav.portal_attachment.node_id || ""}:bSubtype=${nav.portal_attachment.bSubtype || ""}`
      : ""
  );
  body.setAttribute("data-navigator-spawn-source", nav && nav.spawn ? nav.spawn.source || "" : "");
  body.setAttribute(
    "data-child-fabric-render-active",
    String(!!(nav && nav.child_render && nav.child_render.active === true))
  );
  const crossing = debug.crossing || null;
  const contextMarker = debug.player_context_marker || null;
  body.setAttribute("data-crossing-phase", crossing ? crossing.phase || "" : "");
  body.setAttribute("data-crossing-handoff-id", crossing ? crossing.handoff_id || "" : "");
  body.setAttribute(
    "data-crossing-exit-accepted",
    crossing ? String(crossing.server_notifications?.exit_intent?.accepted === true) : ""
  );
  body.setAttribute(
    "data-crossing-arrival-accepted",
    crossing ? String(crossing.server_notifications?.arrival?.accepted === true) : ""
  );
  body.setAttribute(
    "data-marker-same-after-crossing",
    contextMarker && typeof contextMarker.same_marker_after_crossing === "boolean"
      ? String(contextMarker.same_marker_after_crossing)
      : ""
  );
  body.setAttribute("data-navigator-promotion-count", nav ? String(nav.promotion_count || 0) : "");
  body.setAttribute(
    "data-player-profile-version",
    debug.player_handoff_profile ? debug.player_handoff_profile.profile_version || "" : ""
  );
  body.setAttribute("data-active-endpoint-key", debug.active ? debug.active.endpoint_key : "");
  body.setAttribute("data-active-backend-url", debug.active ? debug.active.backend_base_url : "");
  body.setAttribute("data-active-location", debug.active ? debug.active.location_id : "");
  body.setAttribute("data-active-world", debug.active ? debug.active.world_id : "");
  body.setAttribute("data-preview-state", debug.preview ? debug.preview.state : "");
  body.setAttribute("data-preview-source-type", debug.preview ? debug.preview.source_type : "");
  body.setAttribute("data-preview-readonly", String(debug.preview ? debug.preview.readonly === true : true));
  body.setAttribute("data-preview-target-location", debug.preview ? debug.preview.location_id || "" : "");
  body.setAttribute("data-preview-target-portal", debug.preview ? debug.preview.target_portal_id || "" : "");
  body.setAttribute("data-preview-target-location-id", debug.preview ? debug.preview.location_id || "" : "");
  body.setAttribute("data-preview-target-portal-id", debug.preview ? debug.preview.target_portal_id || "" : "");
  body.setAttribute("data-preview-fallback-reason", debug.preview ? debug.preview.fallback_reason || "" : "");
  body.setAttribute("data-preview-freshness-ms", debug.preview && debug.preview.freshness_ms !== null ? String(Math.round(debug.preview.freshness_ms)) : "");
  body.setAttribute(
    "data-preview-target-arrival-count-before",
    debug.preview && debug.preview.target_arrival_count_before_preview !== null
      ? String(debug.preview.target_arrival_count_before_preview)
      : ""
  );
  body.setAttribute(
    "data-preview-target-arrival-count-current",
    debug.preview && debug.preview.target_arrival_count_current !== null
      ? String(debug.preview.target_arrival_count_current)
      : ""
  );
  body.setAttribute(
    "data-preview-target-avatar-presence-created",
    String(debug.preview ? debug.preview.target_avatar_presence_created === true : false)
  );
  body.setAttribute(
    "data-preview-target-mutation-count",
    debug.preview && debug.preview.target_mutation_count_during_preview !== null
      ? String(debug.preview.target_mutation_count_during_preview)
      : ""
  );
  body.setAttribute(
    "data-preview-source-camera-relative",
    debug.preview && debug.preview.source_camera_relative_to_portal
      ? JSON.stringify(debug.preview.source_camera_relative_to_portal)
      : ""
  );
  body.setAttribute(
    "data-preview-target-camera-transform",
    debug.preview && debug.preview.target_preview_camera_transform
      ? JSON.stringify(debug.preview.target_preview_camera_transform)
      : ""
  );
  body.setAttribute("data-preview-projection-frame-source", debug.preview ? debug.preview.projection_frame_source || "" : "");
  body.setAttribute("data-camera-mode", debug.camera ? debug.camera.mode : "");
  body.setAttribute("data-camera-follow-distance", debug.camera ? String(debug.camera.follow_distance_m) : "");
  body.setAttribute("data-camera-follow-height", debug.camera ? String(debug.camera.follow_height_m) : "");
  body.setAttribute("data-camera-pitch", debug.camera ? String(debug.camera.pitch_deg) : "");
  body.setAttribute("data-avatar-position", debug.avatar ? vec3Label(debug.avatar.position) : "");
  body.setAttribute("data-avatar-rotation-y", debug.avatar ? fixed3(debug.avatar.rotation_y) : "");
  body.setAttribute("data-avatar-orientation", debug.avatar ? debug.avatar.orientation.join(",") : "");
  body.setAttribute("data-equipment-count", String(debug.equipment.equipped_count));
  body.setAttribute("data-held-item-visible", String(debug.equipment.held_item_visible === true));
  body.setAttribute("data-worn-item-visible", String(debug.equipment.worn_item_visible === true));
  // live same-location pose continuity evidence: what the OBSERVER
  // last applied (render-only mirror) and what the PLAYER last broadcast.
  const livePose = debug.live_player_pose || null;
  body.setAttribute("data-live-player-pose-seq", livePose ? String(livePose.seq) : "");
  body.setAttribute(
    "data-live-player-pose-applied-count",
    livePose ? String(livePose.applied_count) : ""
  );
  body.setAttribute("data-live-player-pose-position", livePose ? vec3Label(livePose.position) : "");
  body.setAttribute(
    "data-live-player-pose-rotation-y",
    livePose ? fixed3(livePose.rotation_y) : ""
  );
  body.setAttribute("data-live-player-pose-from", livePose ? livePose.from_client_id || "" : "");
  const poseBroadcast = debug.player_pose_broadcast || null;
  body.setAttribute(
    "data-player-pose-sent-count",
    poseBroadcast ? String(poseBroadcast.sent_count) : ""
  );
  body.setAttribute("data-source-exit-accepted", String(debug.transition.source_exit_accepted === true));
  body.setAttribute("data-target-arrival-accepted", String(debug.transition.target_arrival_accepted === true));
  body.setAttribute("data-active-endpoint-switched", String(debug.transition.active_endpoint_switched === true));
  body.setAttribute("data-handoff-id", debug.handoff.handoff_id || "");
  body.setAttribute("data-validation-application-level-handoff", String(debug.proof_boundary.application_level_handoff === true));
  body.setAttribute("data-validation-native-teleportxr-teleport", String(debug.proof_boundary.native_teleportxr_teleport === true));
  body.setAttribute("data-validation-first-party-teleportxr-browser-rendering", String(debug.proof_boundary.first_party_teleportxr_browser_rendering === true));
  body.setAttribute("data-validation-standards-conformance", String(debug.proof_boundary.standards_conformance === true));
}

let returnToLobbyInFlight = false;

function syncReturnLobbyButton(debug) {
  const btn = $("btn-return-lobby");
  if (!btn) return;
  const inLobby = !!(debug && debug.location_id === "location-lobby");
  btn.hidden = !isPlayer || inLobby;
  btn.disabled = returnToLobbyInFlight || !isPlayer || inLobby;
  btn.setAttribute("aria-disabled", String(btn.disabled));
}

async function handleReturnLobbyClick() {
  if (!adapter || returnToLobbyInFlight) return;
  returnToLobbyInFlight = true;
  syncReturnLobbyButton(adapter.debugState());
  try {
    const result = await adapter.returnToLobby();
    if (result && result.ok) {
      const notificationId = `return-to-lobby-${Date.now()}`;
      publishNotificationRecord({
        id: notificationId,
        kind: "navigation",
        event_type: "return_to_lobby",
        title: "Returned to lobby",
        summary: "Player returned to the lobby from the header control.",
        source: result.from ? { location_id: result.from.location_id, world_id: result.from.world_id } : null,
        destination: result.to ? { location_id: result.to.location_id, world_id: result.to.world_id } : { location_id: "location-lobby" },
        no_page_reload: result.no_page_reload === true,
      });
      showToast("Returned to lobby", "Player is back in the lobby.", "arrived", { notificationId });
    } else {
      showToast("Lobby return failed", result && result.reason ? result.reason : "Could not return to lobby.", "failed");
    }
  } finally {
    returnToLobbyInFlight = false;
    syncReturnLobbyButton(adapter.debugState());
  }
}

function wireReturnLobbyButton() {
  const btn = $("btn-return-lobby");
  if (!btn || !isPlayer || btn.dataset.returnLobbyWired === "1") return;
  btn.dataset.returnLobbyWired = "1";
  listenAtRoot(btn, "click", handleReturnLobbyClick);
}

/**
 * Phase 2 — replace the live lobby's procedural render
 * with the existing airport WoW graph in the same browser/player session.
 * The data still flows through LiveAdapter.initWow; rendering still flows
 * through buildWowScene, mountAirportTerminalContent, and mountWowSceneAssets.
 */
function mountClientSceneLoad(target) {
  // Compatibility anchors: mountAirportTerminalContent(...),
  // enterClientSceneLoad(...), and returnFromClientSceneLoad(...) now execute
  // inside the scene-runtime controller.
  return sceneRuntimeController.mountClientSceneLoad(target);
}

/**
 * the additive `?wow=<url|id>`
 * boot path: open a WoW world, resolve its Spatial Composition Graph
 * (adapter.initWow), and render it through buildWowScene (the additive render
 * seam) into #scene-mount using the SAME zero-server Three.js idiom mainMsfRead
 * proved. Node counts + positions come from the graph; glTF `spatialAssetURI`
 * assets are LABELED placeholders (real ingest is). The live role/world
 * path and the `.msf` read path are untouched. Exposes window.__wow (+ a
 * visible-pixels probe) for the entry proof.
 */
async function mainWowRead() {
  appEl.className = `role-${role} wow-read`;
  const roleChip = $("role-chip"); if (roleChip) roleChip.textContent = "WoW WORLD";
  const titleEl = $("loc-title"); if (titleEl) titleEl.textContent = "WoW world — Spatial Composition Graph (M2)";
  const metaEl = $("loc-meta"); if (metaEl) metaEl.textContent = `${wowParam} · WoW composition graph · client render (buildWowScene)`;
  const modeEl = $("mode-prov"); if (modeEl) modeEl.innerHTML = `<span class="prov">wow-graph</span>`;
  const lbEl = $("live-backend"); if (lbEl) { lbEl.textContent = "WoW composition graph (local-data-first; live via runtime)"; lbEl.style.color = "var(--muted, #9aa)"; }

  adapter = new LiveAdapter(role, { wowRef: wowParam, noDefaultEquipment: noEquipParam, motionPreference });
  logLine(`M2 wow: opening world ${wowParam}`);
  let resolved = null;
  let loadErr = null;
  try {
    resolved = await adapter.initWow();
    logLine(`M2 wow: graph spatialID=${resolved.spatialID} nodes=${resolved.node_count} source=${resolved.source}`);
  } catch (e) {
    loadErr = (e && e.message) || String(e);
    logLine(`M2 wow: LOAD ERROR: ${loadErr}`);
  }

  // --- render the composition graph into #scene-mount (shared idiom w/ msf-read) ---
  const mount = $("scene-mount");
  const width = (mount && mount.clientWidth) || 1100;
  const height = (mount && mount.clientHeight) || 660;
  let alternateRuntime = null;
  let built = null;
  const renderState = { frames: 0, error: loadErr, renderer_kind: null, width, height };
  try {
    if (!resolved || !resolved.graph) throw new Error(loadErr || "no graph resolved");
    built = buildWowScene(resolved.graph, THREE, { width, height, source: resolved.source });
    const airportTerminal = mountAirportTerminalContent(resolved.graph, built, THREE, { document, motionPreference });
    if (airportTerminal) {
      // identical shape to the scene-runtime controller's
      // `publishTerminalReadyWorld` — `data-terminal-ready-world` names the world
      // whose airport-terminal content mounted, and the airport-specific alias is
      // published only when that world IS the airport. Any other authored world
      // that mounts terminal content must never satisfy an airport arrival gate.
      const terminalReadyWorld = String(resolved?.spatialID || "");
      document.body.setAttribute("data-terminal-ready-world", terminalReadyWorld);
      if (terminalReadyWorld === "world-airport-terminal") {
        document.body.setAttribute("data-airport-terminal-ready", "1");
      } else {
        document.body.removeAttribute("data-airport-terminal-ready");
      }
      logLine(
        `runtime airport: mounted ${airportTerminal.storefront_count} storefronts, ` +
          `${airportTerminal.npc_count} NPC travelers, destination ${airportTerminal.gate.gate}`
      );
    }
    applyStageScenePresentation(built.scene);
    const r = built.render_summary.rendered;
    // asset_load is a STABLE object mutated in place when the async ingest
    // settles, so the window.__wow.render snapshot (taken below) and debugState()
    // both observe the final result.
    renderState.asset_load = { status: "pending", requested: (built.asset_nodes || []).length };
    logLine(`M2 wow: built scene — rendered_nodes=${r.rendered_nodes} asset_placeholders=${r.asset_placeholders} group_gizmos=${r.group_gizmos} (glTF assets loading async — runtime)`);
    alternateRuntime = sceneRuntimeController.mountAlternateRenderer({ built, renderState, width, height });

    // async-load the REAL glTF each `spatialAssetURI` node
    // references and mount it under the node's composed transform. Non-blocking —
    // the RAF loop above reveals each asset as it lands; the labeled placeholder
    // shows until loaded and is KEPT (warn-tinted) if the asset is unavailable.
    // REUSES the avatar GLTFLoader stack (loadGltfSceneAsset) — no second loader.
    const assetNodes = built.asset_nodes || [];
    document.body.setAttribute("data-wow-asset-nodes", String(assetNodes.length));
    // Iteration 2: a live graph's node may link another world's Spatial, Node or World through its
    // spatialAssetURI. Those are composed first (web/wow-inclusion.mjs) and mounted under their nodes;
    // what remains are models, loaded below. A bundled fixture is not composed: its links are models.
    const graphHref = resolved.graph_url ? new URL(resolved.graph_url, location.href).href : null;
    const inclusionHost = resolved.source === "canonical-walk" && graphHref && /^https?:/i.test(graphHref) ? graphHref : null;
    // Iteration 3: the inclusions stay live. Each shown world's event stream (8 at most) re-composes on
    // a change, and the models of re-mounted content load through the same loader and cache.
    const mountIncludedModels = (nodes) => {
      if (!nodes.length) return;
      void mountWowSceneAssets(nodes, THREE, {
        loadGltf: loadGltfSceneAsset,
        cloneScene: environmentAwareClone(cloneGltfSceneAsset),
        cache: sceneRuntimeController.destinationAssetCache(),
        baseUrl: resolved.base_url || resolved.graph_url || location.href,
      });
    };
    const modelsReady = inclusionHost
      ? mountLiveInclusions({
          built, hostUrl: inclusionHost, THREE, buildWowScene, document,
          fetch: window.fetch.bind(window), WebSocket: window.WebSocket,
          onModels: mountIncludedModels,
          onUpdate: (summary, live) => {
            window.__wowInclusions = { summary, live: live.live };
            document.body.setAttribute("data-wow-live-updates", String(live.live.updates));
          },
        })
          .then((mounted) => {
            window.__wowInclusions = { summary: mounted.summary, composition: mounted.composition, live: mounted.live.live };
            document.body.setAttribute("data-wow-inclusions", JSON.stringify(mounted.summary.by_status));
            logLine(`wow inclusions: ${mounted.summary.graphs_shown} graph(s) shown, ${mounted.summary.placeholders.length} placeholder(s), ${mounted.summary.cycles} cycle(s)`);
            return mounted.modelNodes;
          })
          .catch((e) => {
            logLine(`wow inclusions ERROR: ${(e && e.message) || e}`);
            return assetNodes;
          })
      : Promise.resolve(assetNodes);
    void modelsReady.then((modelNodes) => {
    document.body.setAttribute("data-wow-inclusions-ready", "1");
    if (modelNodes.length) {
      const assetBaseUrl = resolved.base_url || resolved.graph_url || location.href;
      mountWowSceneAssets(modelNodes, THREE, {
        loadGltf: loadGltfSceneAsset,
        cloneScene: environmentAwareClone(cloneGltfSceneAsset),
        cache: sceneRuntimeController.destinationAssetCache(),
        baseUrl: assetBaseUrl,
        onAsset: (a, model, assetRecord) => {
          void built.airport_entity_runtime?.attachAsset(a, model, assetRecord);
          logLine(`M2 wow asset ${a.status}: ${a.label}${a.from_cache ? " (cache)" : ""}${a.error ? " — " + a.error : ""}`);
        },
      })
        .then((sum) => {
          Object.assign(renderState.asset_load, sum, { status: "settled" });
          document.body.setAttribute("data-wow-assets-loaded", String(sum.loaded));
          document.body.setAttribute("data-wow-assets-failed", String(sum.failed));
          logLine(
            `M2 wow: glTF ingest settled — loaded=${sum.loaded} failed=${sum.failed} network=${sum.network_loads} cache_hits=${sum.cache_hits} (real assets via reused avatar GLTFLoader)`
          );
        })
        .catch((e) => {
          Object.assign(renderState.asset_load, { status: "error", error: (e && e.message) || String(e) });
          document.body.setAttribute("data-wow-assets-loaded", "0");
          logLine(`M2 wow: glTF ingest ERROR: ${renderState.asset_load.error}`);
        });
    } else {
      Object.assign(renderState.asset_load, { status: "settled", loaded: 0, failed: 0, note: "no spatialAssetURI nodes in this graph" });
      document.body.setAttribute("data-wow-assets-loaded", "0");
    }
    });
  } catch (e) {
    renderState.error = (e && e.message) || String(e);
    logLine(`M2 wow RENDER ERROR: ${renderState.error}`);
  }

  // --- CONSUMER-POV AVATAR WALK on the WoW-rendered world ---
  // REUSE, don't rebuild. The player's VRM avatar, WASD movement, and the
  // consumer orbit-follow camera are the EXACT modules the live world uses —
  // imported and CALLED here, never reimplemented:
  //   • adapter.stepAvatar        — WASD integrator (camera-relative basis, jump/gravity)
  //   • movementCameraController   — the shared input loop / rAF tick + camera rig
  //   • AvatarEquipmentLayer + setAvatar — the VRM avatar visual overlay
  //   • adapter.applyRestoredPose  — reload-resume
  // Only the world DATA SOURCE differs (a WoW composition graph), and the movement
  // clamp is MEASURED from THIS world's extent (buildWowScene walkable_extent) —
  // NOT the old hardcoded ±5.4 procedural bound.
  let avatarWalk = null;
  if (isPlayer && built && !loadErr) {
    try {
      const wk =
        built.render_summary && built.render_summary.walkable_extent
          ? built.render_summary.walkable_extent
          : null;
      const spawn = wk && Array.isArray(wk.spawn) ? wk.spawn : [0, 0, 0, 0];
      const bounds = wk
        ? { minX: wk.min_x, maxX: wk.max_x, minZ: wk.min_z, maxZ: wk.max_z }
        : null;

      // (1) spawn the local avatar STATE — the SAME creation the live path uses
      // (adapter._spawnEmbodiedAvatarState), with the per-world movement clamp.
      adapter.spawnWowLocalAvatar({
        spawn,
        bounds,
        spatialID: resolved ? resolved.spatialID : null,
        title: (resolved && resolved.graph && resolved.graph.title) || "WoW world",
      });

      // (2) SceneRuntime has already exposed the built WoW scene through the
      // SAME `scene._impl` seam the reused camera rig drives.

      // (3) the VRM avatar — the EXACT AvatarEquipmentLayer the live world
      // renders.: parented into THIS world's scene/depth buffer via the
      // host seam (scene._impl was published in step (2) above), no overlay canvas.
      equipmentLayer = new AvatarEquipmentLayer($("scene-mount"), role, adapter.world, {
        host: avatarLayerHost(),
        motionPreference,
      });
      await equipmentLayer.ready;
      equipmentLayer.setAvatar(adapter.state.avatar);
      // Keep the visual synced to the movement integrator: stepAvatar _emit()s a
      // "state" event each move tick — feed its avatar straight to setAvatar (the
      // SAME method onState uses on the live path; no re-implementation).
      listenAtRoot(adapter, "state", (ev) => {
        if (equipmentLayer && ev.detail && ev.detail.avatar) equipmentLayer.setAvatar(ev.detail.avatar);
      });

      // (4) LEGIBLE consumer framing: seat the orbit camera BEHIND the avatar
      // looking down +z toward the hall/portal (azimuth π), so W walks toward the
      // content and the avatar reads at stage distance. The movement/camera
      // controller then initializes the follow focus at the spawn.
      // then inits the follow-focus at the spawn. Rig reused verbatim.
      movementCameraController.seedOrbitCamera({ azimuth: Math.PI });

      // (5) reload-resume: a genuine browser reload carrying a saved pose resumes
      // where the player stood (applyRestoredPose reused verbatim).
      const restorable = readRestorablePlayerSession();
      if (restorable && typeof adapter.applyRestoredPose === "function" && adapter.applyRestoredPose(restorable)) {
        movementCameraController.seedOrbitCamera({
          azimuth: restorable.orbit_azimuth_rad,
          polar: restorable.orbit_polar_rad,
          distance: restorable.orbit_distance_m,
        });
        equipmentLayer.setAvatar(adapter.state.avatar);
        logLine(`M2 wow: session restore — resumed avatar at ${vec3Label(restorable.position)}`);
      }

      // (6) DRIVE it — the SAME input loop + camera rig the live world runs.
      movementCameraController.start();
      movementCameraController.applyPlayerCamera();

      avatarWalk = {
        embodied: true,
        spawn,
        walkable_extent: wk,
        movement_clamp_source:
          "MEASURED from the WoW world content extent (buildWowScene walkable_extent); NOT the hardcoded ±5.4",
        reused_verbatim: [
          "adapter.stepAvatar",
          "movementCameraController.start / applyPlayerCamera / movementBasisYaw",
          "AvatarEquipmentLayer / setAvatar",
          "movementCameraController orbit/touch/camera-mode listeners",
          "adapter.applyRestoredPose",
        ],
        reimplemented: "none",
      };
      document.body.setAttribute("data-wow-avatar-embodied", "1");
      logLine(
        `M2 wow: consumer-POV avatar walk ARMED — spawn=${vec3Label(spawn)} ` +
          `clamp x[${wk ? wk.min_x : "?"},${wk ? wk.max_x : "?"}] z[${wk ? wk.min_z : "?"},${wk ? wk.max_z : "?"}] ` +
          `(measured per world; reusing stepAvatar + orbit camera + VRM layer)`
      );
    } catch (e) {
      avatarWalk = { embodied: false, error: (e && e.message) || String(e) };
      document.body.setAttribute("data-wow-avatar-embodied", "0");
      logLine(`M2 wow: avatar walk wiring ERROR: ${avatarWalk.error}`);
    }
  }

  // --- honest visible-pixels probe (same shape as mainMsfRead's) ---
  function probeVisiblePixels() {
    return alternateRuntime
      ? sceneRuntimeController.probeVisiblePixels()
      : { ok: false, reason: "no_renderer", non_black: 0 };
  }

  const panelDebug = adapter && adapter.world ? adapter.debugState() : { proof_boundary: null };
  panelTruthChromeController.mount({ debug: panelDebug });

  // --- expose the single honest `wow` debug surface for the entry proof ---
  const wowSurface = {
    ref: wowParam,
    resolved,
    render: { ...renderState, render_summary: built ? built.render_summary : null },
    // the consumer-POV avatar-walk surface (null unless this
    // is a player load). Exposes the live avatar pose + the measured per-world
    // clamp + the list of REUSED (not reimplemented) movement/camera/avatar fns.
    avatar_walk: avatarWalk,
    avatarState: () => (adapter && adapter.state ? adapter.state.avatar : null),
    renderIdentity: () => alternateRuntime,
    probeVisiblePixels,
    debugState: () => ({
      wow: resolved,
      render: renderState,
      avatar_walk: avatarWalk,
      avatar: adapter && adapter.state ? adapter.state.avatar : null,
      movement_bounds: adapter ? adapter._movementBounds : null,
    }),
  };
  window.__wow = wowSurface;
  window.__assembly = window.__assembly || {
    role,
    adapter,
    wow: wowSurface,
    debugState: () => ({ wow: resolved, render: renderState }),
    probeVisiblePixels,
    equipmentReady: () => true,
    dispose: disposeApplication,
    panelGroups: panelTruthChromeController.groupDriver(),
    chrome: panelTruthChromeController.chromeDriver(),
  };
  document.body.setAttribute("data-wow-ready", "1");
  document.body.setAttribute("data-wow-nodes", String(resolved ? resolved.node_count : 0));
  document.body.setAttribute("data-wow-rendered", String(built ? built.render_summary.rendered.rendered_nodes : 0));
  logLine(`M2 wow: ready (render frames=${renderState.frames}, renderer=${renderState.renderer_kind || "none"})`);
}

function handleAdapterState(event) {
  onState(event.detail);
}

// P4: which handoff phases THIS window observed (see onState).
const observedPhaseLog = [];
let lastObservedPhase = null;

// the traversed-edge geometry now owns the final landing
// standoff before visual commit. This historical P3 seam remains as a
// fail-closed compatibility guard only: it may observe at most 0.05 m of
// dispatch drift and never moves the avatar or translates the camera mapping.
let lastExitPoseParity = null;

function applyExitPoseParity(detail) {
  if (!adapter || !detail || detail.kind !== "world_navigator_composition_crossing") return null;
  const dbg = adapter.debugState();
  const profile = dbg ? dbg.player_handoff_profile : null;
  const portalInfo = profile ? profile.portal : null;
  const targetFrame = portalInfo ? portalInfo.target_portal_frame : null;
  const avatar = dbg ? dbg.avatar : null; // live reference into adapter state
  const exitPose = detail.exit_pose || null;
  // #5 tripwire — the per-world `world.arrival` fallback is RETIRED as a
  // crossing landing: with P1's reciprocal edges every crossing carries a real
  // frame mapping, so the only way to land on `world.arrival` again is the
  // fallback exit-pose branch WITHOUT a mapped exit. Surfaced, asserted false
  // by the proofs; must never silently come back.
  const arrivalFallbackUsed = !!(
    exitPose &&
    exitPose.source === "portal_frame_mapping_fallback" &&
    !(profile && profile.player_pose_at_crossing && profile.player_pose_at_crossing.mapped_exit_transform)
  );
  // #1 client — the crossing's stable connection identity, derived by the P1
  // rule from the two endpoint locations (identical on both sides). The
  // machine-level adopted-pose identity is asserted at the preview seam.
  const fromLocation = detail.from ? detail.from.location_id : null;
  const toLocation = detail.to ? detail.to.location_id : null;
  const record = {
    at: new Date().toISOString(),
    kind: detail.kind,
    handoff_id: detail.handoff_id || null,
    applied: false,
    reason: null,
    source_portal_id: portalInfo ? portalInfo.source_portal_id : null,
    target_portal_id: portalInfo ? portalInfo.target_portal_id : null,
    edge_id: expectedPortalEdgeId(fromLocation, toLocation),
    exit_pose_source: exitPose ? exitPose.source || null : null,
    arrival_fallback_used: arrivalFallbackUsed,
    parity: null,
    camera_mapping_translated: false,
  };
  if (!avatar || !Array.isArray(avatar.position) || !exitPose || !Array.isArray(exitPose.position)) {
    record.reason = "avatar_or_exit_pose_unavailable";
  } else {
    const policy = exitPose.landing_policy || null;
    const local = targetFrame ? portalLocalCoordinates(targetFrame, avatar.position) : null;
    const correctionM = Math.hypot(
      Number(avatar.position[0]) - Number(exitPose.position[0]),
      Number(avatar.position[1]) - Number(exitPose.position[1]),
      Number(avatar.position[2]) - Number(exitPose.position[2]),
    );
    const standoffM = local ? Number(local.signed_plane_distance_m) : NaN;
    const triggerDepthM = Number(policy && policy.trigger_depth_m);
    const actorClearanceM = Number(policy && policy.actor_clearance_m);
    const safeMinimumM = triggerDepthM + actorClearanceM;
    record.parity = {
      supported: !!policy && Number.isFinite(standoffM) && Number.isFinite(safeMinimumM),
      entry_standoff_m: policy ? policy.entry_plane_sample_m : null,
      applied_standoff_m: Number.isFinite(standoffM) ? Number(standoffM.toFixed(4)) : null,
      parity_standoff_m: policy ? policy.standoff_m : null,
      delta_m: Number(correctionM.toFixed(4)),
      adjusted_position: avatar.position.slice(0, 3),
      inside_trigger_volume_after: Number.isFinite(standoffM) && Number.isFinite(triggerDepthM)
        ? standoffM <= triggerDepthM
        : null,
      landing_policy: policy,
    };
    if (!record.parity.supported) {
      throw new Error("portal landing guard: canonical traversed-edge policy unavailable");
    }
    if (correctionM > 0.05) {
      throw new Error(`portal landing guard: dispatch drift ${correctionM.toFixed(4)} m exceeds 0.05 m`);
    }
    if (standoffM + 1e-6 < safeMinimumM) {
      throw new Error(
        `portal landing guard: ${standoffM.toFixed(4)} m is inside the ` +
          `${safeMinimumM.toFixed(4)} m trigger-plus-clearance boundary`,
      );
    }
    record.reason = "canonical_exit_pose_verified";
  }
  lastExitPoseParity = record;
  const body = document.body;
  body.setAttribute("data-exit-parity-applied", String(record.applied));
  body.setAttribute(
    "data-exit-parity-entry-m",
    record.parity && Number.isFinite(record.parity.entry_standoff_m) ? String(record.parity.entry_standoff_m) : ""
  );
  body.setAttribute(
    "data-exit-parity-exit-m",
    record.parity && Number.isFinite(record.parity.parity_standoff_m)
      ? String(record.applied ? record.parity.parity_standoff_m : record.parity.applied_standoff_m)
      : ""
  );
  body.setAttribute(
    "data-exit-parity-delta-m",
    record.parity && Number.isFinite(record.parity.delta_m) ? String(record.parity.delta_m) : ""
  );
  body.setAttribute("data-exit-pose-source", record.exit_pose_source || "");
  body.setAttribute("data-exit-arrival-fallback-used", String(arrivalFallbackUsed));
  body.setAttribute("data-crossing-edge-id", record.edge_id || "");
  if (arrivalFallbackUsed) {
    logLine("exit parity: WARNING — crossing landed on the per-world arrival fallback (retired path)");
  }
  return record;
}

// the traversal controller now derives camera, heading,
// and movement-basis continuity from the packet's exact traversed edge. Keep
// the historical consumer seam as a fail-closed validation only. It
// recomputes the expected transform but never corrects the crossing record.
let lastCrossingHeadingContinuity = null;

function reframeAdapterCrossingHeading(detail) {
  if (!adapter || !detail || detail.kind !== "world_navigator_composition_crossing") return null;
  const dbg = adapter.debugState();
  const profile = dbg ? dbg.player_handoff_profile : null;
  const profileMatches =
    profile && (!detail.handoff_id || !profile.handoff_id || profile.handoff_id === detail.handoff_id);
  const portalInfo = profileMatches ? profile.portal : null;
  const frameMapping =
    portalInfo && portalInfo.source_portal_frame && portalInfo.target_portal_frame
      ? {
          source_portal_frame: portalInfo.source_portal_frame,
          target_portal_frame: portalInfo.target_portal_frame,
        }
      : null;
  const pose = profileMatches ? profile.player_pose_at_crossing : null;
  const sourceMapping = detail.camera_mapping || null;
  const record = reframeCrossingCameraMapping({
    detail,
    frameMapping,
    entryTransform:
      (sourceMapping && sourceMapping.source_avatar_entry_transform) ||
      (pose ? pose.portal_entry_transform : null),
    cameraTransform:
      (sourceMapping && sourceMapping.source_camera_transform) ||
      (profileMatches && profile.camera ? profile.camera.camera_transform : null),
  });
  lastCrossingHeadingContinuity = {
    at: new Date().toISOString(),
    handoff_id: detail.handoff_id || null,
    profile_matched: profileMatches === true,
    reframe: record,
    heading_continuity: detail.heading_continuity || null,
    applied_remap: null, // filled in by handleAdapterCrossing after the seed
    basis_yaw_after: null,
    camera_yaw_after: null,
  };
  if (!record || !record.validated || record.changed) {
    throw new Error(
      `crossing heading guard: ${record ? record.reason : "validation unavailable"} ` +
        `for ${record && record.source_portal_id ? record.source_portal_id : "?"} -> ` +
        `${record && record.target_portal_id ? record.target_portal_id : "?"}`
    );
  }
  return lastCrossingHeadingContinuity;
}

function handleAdapterCrossing(event) {
  const detail = event.detail || {};
  logLine(
    detail.kind === "reset_demotion"
      ? "world-navigator: reset — boot fabric restored as root (same context)"
      : `world-navigator: child fabric PROMOTED to root (handoff ${detail.handoff_id || "?"}); ` +
          `exit-intent/arrival were server-side notifications only`
  );
  // source-mapping guard first; it is a no-op on the valid packet.
  const headingReframe = reframeAdapterCrossingHeading(detail);
  // source-landing guard; it is also a no-op on the valid packet.
  const exitParity = applyExitPoseParity(detail);
  if (exitParity && exitParity.applied) {
    logLine(
      `exit parity: stepped out ${exitParity.parity.parity_standoff_m} m from the portal ` +
        `(entry ${exitParity.parity.entry_standoff_m} m; adapter floor was ${exitParity.parity.applied_standoff_m} m)`
    );
  }
  // adopt the frame-mapped REAL-camera pose so the orbit
  // camera keeps its avatar-relative orientation across the crossing.
  // maps the orbit BEFORE destination scene publication; recompose then applies
  // that mapped orbit to the new camera and rehosts the same rig in one turn.
  if (detail.kind !== "reset_demotion" && detail.kind !== "return_to_lobby") {
    const remapped = movementCameraController.handleCrossing(detail);
    logLine(
      remapped === "heading_delta"
        ? "camera: orbit heading rotated by the traversed edge's yaw delta (no camera mapping; movement basis stayed continuous)"
        : remapped
          ? "camera: orbit pose remapped through the portal frames (relative view preserved)"
          : "camera: no crossing camera mapping in this record; orbit pose kept as-is"
    );
    // measurement surface: the movement basis and the applied camera
    // yaw AT THE EMERGENCE STEP, straight from the controller — the proofs and
    // headed evidence assert their equality here rather than eyeballing it.
    if (isPlayer && detail.kind === "world_navigator_composition_crossing") {
      const basisYaw = movementCameraController.movementBasisYaw();
      // playerCameraDebug() is only refreshed by updatePlayerCamera — read the
      // camera through the canonical update so the measured yaw is the
      // POST-SEED applied camera, not the pre-crossing debug snapshot.
      const cameraDebug = movementCameraController.updatePlayerCamera(adapter.debugState());
      const cameraYaw = cameraDebug && Number.isFinite(Number(cameraDebug.rotation_y))
        ? Number(cameraDebug.rotation_y)
        : null;
      if (headingReframe) {
        headingReframe.applied_remap = remapped === true ? "camera_mapping" : remapped || "none";
        headingReframe.basis_yaw_after = Number.isFinite(basisYaw) ? Number(basisYaw.toFixed(6)) : null;
        headingReframe.camera_yaw_after = cameraYaw === null ? null : Number(cameraYaw.toFixed(6));
      }
      const body = document.body;
      body.setAttribute("data-crossing-camera-remap", remapped === true ? "camera_mapping" : String(remapped || "none"));
      body.setAttribute(
        "data-crossing-heading-delta-rad",
        detail.heading_continuity && Number.isFinite(Number(detail.heading_continuity.crossing_yaw_delta_rad))
          ? String(detail.heading_continuity.crossing_yaw_delta_rad)
          : ""
      );
      body.setAttribute("data-crossing-basis-yaw-rad", Number.isFinite(basisYaw) ? basisYaw.toFixed(6) : "");
      body.setAttribute("data-crossing-camera-yaw-rad", cameraYaw === null ? "" : cameraYaw.toFixed(6));
    }
  } else if (detail.kind === "return_to_lobby") {
    // Compatibility anchor: the controller's return branch executes
    // seedOrbitCamera({ azimuth: 0 }) before applying the lobby camera.
    movementCameraController.handleCrossing(detail);
  } else {
    movementCameraController.handleCrossing(detail);
  }
  recomposeActiveWorldScene(detail.kind || "crossing");
  onState(adapter.debugState());
  // Snapshot the newly active fabric and pose in sessionStorage without URL
  // or history mutation.
  movementCameraController.persistSession(true);
}

async function main() {
  // the additive WoW entry — a world URL/id
  // sources the Spatial Composition Graph and renders it via buildWowScene; the
  // live ENDPOINTS/role boot below is bypassed for this load only.
  if (wowParam) {
    await mainWowRead();
    return;
  }
  // M1: the additive read path — a fabric URL sources the
  // root; the live ENDPOINTS/role boot below is bypassed for this load only.
  // the inspector (right rail) is CLOSED by default for
  // EVERY live role — not just players. The static markup already ships
  // #app.rail-collapsed (web/index.html), so there is no flash of an open panel
  // on load; this assignment preserves the collapse rather than reversing it.
  // The manual #btn-rail-toggle is the only thing that opens the panel.
  appEl.className = `role-${role} rail-collapsed`;
  $("role-chip").textContent = ROLE_DISPLAY_LABEL[role] || role.toUpperCase();
  const initialRailToggle = $("btn-rail-toggle");
  if (initialRailToggle) initialRailToggle.setAttribute("aria-expanded", "false");

  // on a manual browser reload, boot into the fabric the
  // player was last standing in (from sessionStorage) instead of the URL's
  // original `active`; on first/fresh loads this is just `activeParam`. No URL
  // or history mutation happens here — the fabric key comes from sessionStorage.
  // hand the URL/hash-derived WoW intent to the adapter. The ONLY thing
  // it changes is whether this session registers presence (preview does not). Absent a WoW
  // intent the adapter behaves exactly as it did before this change.
  adapter = new LiveAdapter(role, {
    active: resolveBootActive(),
    wowIntent: wowUrlIntent,
    noDefaultEquipment: noEquipParam,
    motionPreference,
    portalAtomicityOracle: portalAtomicityOracleParam,
  });
  await adapter.init();
  if (isPlayer && adapter.debugState().location_id === "location-lobby") {
    serverBApertureMachine = await loadBackendApertureMachine(apiBase("b"), "location-b-portal");
    document.body.setAttribute(
      "data-server-b-aperture-entities",
      String(serverBApertureMachine?.region?.entities?.length || 0)
    );
  }
  adapter.listenForCrossWindow();

  // the fragment is live. Editing the hash (#preview <-> #join, or
  // #follow=<aspect>) re-routes the intent WITHOUT a reload — a hashchange fires no navigation,
  // so the nav-count==1 guard is unaffected. Nothing here ever WRITES the URL.
  listenAtRoot(window, "hashchange", () => {
    const next = readWowUrlIntent();
    if (next && adapter && typeof adapter.applyWowIntent === "function") {
      void adapter.applyWowIntent(next);
    }
  });

  // If this load is a genuine browser RELOAD carrying a saved pose for the
  // fabric we just booted into, resume at the player's last walked spot instead
  // of the room spawn (pose only — the world was already selected above).
  if (isPlayer) {
    const restorable = readRestorablePlayerSession();
    if (restorable && typeof adapter.applyRestoredPose === "function") {
      const applied = adapter.applyRestoredPose(restorable);
      if (applied) {
        movementCameraController.setRestoredCameraSeed({
          azimuth: restorable.orbit_azimuth_rad,
          polar: restorable.orbit_polar_rad,
          distance: restorable.orbit_distance_m,
        });
        logLine(
          `session restore: manual reload → resumed on ${restorable.active_endpoint_key} (${restorable.location_id || "?"}) ` +
            `at ${vec3Label(restorable.position)} (pose from sessionStorage; no world reset)`
        );
      }
    }
  }

  const world = adapter.world;
  $("loc-title").textContent = world.title;
  $("loc-meta").textContent = `${world.location_id} · ${world.world_id} · ${world.session_id}`;
  $("mode-prov").innerHTML = `<span class="prov prov-${adapter.mode}">${adapter.mode}</span>`;
  // live backend indicator (this IS a live backend now)
  const lb = $("live-backend");
  if (lb) { lb.textContent = adapter.base; lb.style.color = "var(--ok)"; }

  const cb = adapter.claimBoundary();
  flagCell($("f-alh"), cb.application_level_handoff);
  flagCell($("f-ntt"), cb.native_teleportxr_teleport);
  flagCell($("f-fpr"), cb.first_party_teleportxr_browser_rendering);
  flagCell($("f-std"), cb.standards_conformance);
  const bs = adapter.boundaryStatus();
  $("f-check").textContent = bs.ok ? "PASS" : `FAIL: ${bs.problems.join("; ")}`;
  $("f-check").className = "v " + (bs.ok ? "boundary-ok" : "boundary-bad");
  if (!bs.ok) logLine(`validation-BOUNDARY FAILURE: ${bs.problems.join("; ")}`);

  const sceneRole = activeSceneRole(adapter.debugState());
  // Characterization anchor: scene = new Scene is now owned by SceneRuntime.
  sceneRuntimeController.mountLive({ world, sceneRole, phase: adapter.state.phase });
  // the local avatar is parented into the world scene just
  // created above — one scene, one depth buffer (host is null only on canvas2d
  // degrade or the ?avatar_compositing=stacked negative arm, where the layer
  // falls back to its pre-060 own-canvas overlay).
  equipmentLayer = new AvatarEquipmentLayer($("scene-mount"), role, world, {
    host: avatarLayerHost(),
    motionPreference,
  });
  await equipmentLayer.ready;
  // derive the two defaults from the loaded run clip and the accepted
  // translation path, then install them atomically in the existing movement
  // owner. No URL, storage, backend, or cross-session default is written.
  if (isPlayer) {
    const sourceRunCalibration = equipmentLayer.characterizeRunCalibration(
      adapter.runCalibrationSnapshot().source_translation_speed_mps
    );
    adapter.setRunCalibration({
      run_cycle_speed: sourceRunCalibration.run_cycle_speed,
      run_cycle_distance: sourceRunCalibration.run_cycle_distance,
    });
    const runtimeTweakRegistry = createRunTweakRegistry({
      sourceDefaults: sourceRunCalibration,
      readCalibration: () => adapter.runCalibrationSnapshot(),
      applyCalibration: (values) => adapter.setRunCalibration(values),
    });
    runtimeTweakController = createRuntimeTweakController({
      view: window,
      document,
      toggle: $("btn-runtime-tweaks"),
      palette: $("runtime-tweak-palette"),
      rows: $("runtime-tweak-rows"),
      closeButton: $("btn-runtime-tweak-close"),
      copyAllButton: $("btn-runtime-tweak-copy-all"),
      resetAllButton: $("btn-runtime-tweak-reset-all"),
      status: $("runtime-tweak-status"),
      fallback: $("runtime-tweak-copy-fallback"),
      resizeHandle: $("runtime-tweak-resizer"),
      registry: runtimeTweakRegistry,
    });
    runtimeTweakController.mount();
    logLine(
      `runtime tweaks: source run=${sourceRunCalibration.run_cycle_speed.toFixed(4)} cycles/s × ` +
        `${sourceRunCalibration.run_cycle_distance.toFixed(3)} m/cycle = ` +
        `${sourceRunCalibration.effective_run_translation_speed_mps.toFixed(3)} m/s (session-local)`
    );
  }
  // the cosmetic "FALLBACK verifier" banner element was
  // removed from all three views. The substantive honesty flags (DATA
  // PROVENANCE native=false/std=false, native_teleportxr_teleport:false) still
  // render in the "Proof-boundary flags" debug card below (flagCell/f-ntt/
  // f-std) — only this console log + the on-screen badge are gone.
  logLine(`renderer: ${scene.rendererKind} (application renderer; not first-party TeleportXR)`);
  logLine(`portal visual alignment: ${portalVisualAlignment.reason || "unknown"} center=${vec3Label(portalVisualAlignment.visual_center || portalVisualAlignment.trigger_center)}`);
  logLine(`LIVE backend bound: ${adapter.base}`);
  if (isPlayer) {
    sceneRuntimeController.refreshNavigator();
    const nav = adapter.debugState().navigator;
    if (nav) {
      logLine(
        `world-navigator: ${nav.status} · context=${nav.context_id} · fabrics=[${(nav.fabrics_loaded || []).join(", ")}]`
      );
      logLine(
        `fabric manifests are plain-JSON and UNSIGNED (labeled); no standards-conformance claim`
      );
    }
  }

  // game-engine editor panel chrome — collapsible rail (#6),
  // per-section accordions (#7), and window-resize plumbing (#22). Pure DOM/UI;
  // no controller/crossing/camera logic is touched.
  panelTruthChromeController.mount({ debug: adapter.debugState() });
  wireNotificationCenter();
  wireReturnLobbyButton();
  semanticDestinationsController.mount();
  storefrontShoppingController.mount();
  boardingJourneyController.mount();

  listenAtRoot(adapter, "state", handleAdapterState);
  listenAtRoot(adapter, "crossing", handleAdapterCrossing);
  onState(adapter.debugState());

  // wire the Web of Worlds API activity panel (log already
  // subscribed at module load; this attaches chips/presenter + the spec line).
  panelTruthChromeController.mount({
    apiPanel: true,
    standards: true,
    debug: adapter.debugState(),
  });

  // the panel chrome controller force-opens the inspector
  // when it first mounts (wirePanelChrome -> setPanelOpen(true), unconditional).
  // The inspector stays CLOSED by default on the live role path, so
  // immediately re-collapse it here via the controller's own public API. This
  // runs synchronously, in the same frame as the mount above (there is no await
  // between them), so the panel never paints open — no flash. The pre-mount
  // collapsed default (static #app.rail-collapsed + the role-`${role} rail-collapsed`
  // className) keeps it closed during `await adapter.init()`; this close() keeps
  // it closed after mount. The manual #btn-rail-toggle stays the only opener.
  // NOTE: the ?wow= / ?fabric= read modes (mainWowRead/mainMsfRead) deliberately
  // do NOT close here — those inspection views default the panel open.
  panelTruthChromeController.chromeDriver().close();

  // ALL bottom control-bar buttons — "Debug: activate
  // portal" / "Debug: depart" / "Debug: simulate arrival" AND the plain
  // "Reset" button — and their click handlers were removed from all three
  // views (scope update: Reset removed too, not kept). Portal
  // activation / handoff / arrival are driven by the avatar walking into the
  // trigger volume (see maybeTriggerAutoHandoff / startAvatarControls) and,
  // for headless e2e / operator reset, via window.__assembly.reset() /
  // .activatePortal() / .triggerHandoff() / .applyArrival() below and the
  // live POST /reset endpoint — those driver paths are untouched. The bottom
  // bar itself stays, but its only VISIBLE content is now
  // the github link footer; the old "LIVE real Lane 3 backend" status label is
  // still written by setConnectionPresentation() below, just no longer shown.
  movementCameraController.start();
  // header camera-icon toggle (player only, no text ever).
  // Calls the exact same togglePlayerCameraMode() the C hotkey and the legacy
  // in-canvas button already use — this is an additional trigger, not a new
  // state machine. The legacy button (#btn-camera-mode) still exists and still
  // works (C still toggles it), it is just CSS-hidden (web/index.html) now that
  // this header control replaces it as the discoverable affordance.
  const cameraToggleBtn = $("btn-camera-toggle");
  if (cameraToggleBtn && isPlayer) {
    cameraToggleBtn.hidden = false;
    cameraToggleBtn.setAttribute(
      "aria-pressed",
      String(movementCameraController.playerCameraMode() === "first_person")
    );
    cameraToggleBtn.addEventListener("click", () => {
      const next = movementCameraController.togglePlayerCameraMode();
      cameraToggleBtn.setAttribute("aria-pressed", String(next === "first_person"));
    });
  }
  // Patch 6: one controller owns the staged selector, preview loop,
  // focus/pointer listeners, and hidden legacy inventory compatibility seam.
  avatarSelectorController.mount();
  // portal-render proof — hosted scene objects, reloadable
  // UM attach-point re-reads, resolution-ladder panels, and the observer
  // top-down drag surface (objects + portal). Labeled demo extension.
  portalRenderController.mount();
  // BEGIN — loading-content THROUGH the portal (P11),
  // re-presented: the destination's metaverse.portal.*
  // loading content + the crossing's real background steps now surface as a
  // small transient toast + a structured notification record (published into
  // the notification shell above; the notification center
  // consumes those records). The center-screen loading card is REMOVED (owner
  // mandate: nothing mid-screen during traversal, ever). Content still comes
  // from the DESTINATION server via the reload cache (or one lazy
  // fetch); nothing is hardcoded client-side. Player window only; adds no
  // delay to the crossing. Demonstration-only.
  featureInitPortalLoadingOverlay({
    isPlayer,
    adapter,
    readCachedLoadingContent: (key) => {
      const cached = portalRenderController.getCachedAttachPoint(key);
      return cached ? featureExtractPortalLoadingContent(cached) : null;
    },
    fetchLoadingContent: async (key) => {
      const view = await adapter.demoReadPortalView(key, "color");
      return featureExtractPortalLoadingContent(view);
    },
    showToast,
    publishNotification: publishNotificationRecord,
    logLine,
  });
  // END

  // apply the restored orbit framing (if this load
  // resumed a reloaded session) now that the rig is wired; the focus point
  // re-seeds from the restored avatar position on the first tick. Then keep the
  // session persisted on the way out so the LATEST spot survives the refresh.
  // Session flush listeners and the immediate first snapshot are owned by the
  // movement/camera controller's symmetric start/stop lifecycle.

  logLine(`frontend contract exposed: ${FRONTEND_CONTRACT.version_id} (${FRONTEND_CONTRACT.components})`);
  logLine(`role=${role} mode=${adapter.mode}`);
  logLine(`claim ceiling: ${FRONTEND_CONTRACT.claim_ceiling}`);
  if (isPlayer) {
    logLine(`player URL active=${adapter.activeEndpointKey} preview=${adapter.previewEndpointKey}`);
  }

  // deterministic driver for the headless e2e capture
  window.__assembly = {
    role,
    connectionStatus: () => ({ ...connectionPresentation }),
    contract: FRONTEND_CONTRACT,
    adapter,
    scene,
    rendererKind: scene.rendererKind,
    viewport: {
      snapshot: liveViewportSnapshot,
      forceSync: () => applyLiveViewport(true),
      schedule: scheduleLiveViewport,
      identity: () => {
        const impl = scene && scene._impl;
        const visual = adapterVisualRuntimeSnapshot();
        return {
          scene,
          renderer: impl && impl.renderer,
          camera: impl && impl.camera,
          canvas: impl && (impl.renderer ? impl.renderer.domElement : impl.canvas),
          avatar: visual?.state?.avatar || null,
          world: visual?.world || null,
          portal: visual?.state?.portal || null,
        };
      },
    },
    debugState: () => {
      const debug = canonicalDebugState(adapterVisualDebugState());
      const previewSurface = updatePortalPreviewSurface(debug);
      if (previewSurface) {
        portalVisualAlignment = { ...(portalVisualAlignment || {}), preview_surface: previewSurface };
      }
      // always expose the portal visual alignment (it now
      // carries the traversal affordance evidence — arrow removal + blocked-
      // side opacity), not only when a preview surface is active.
      debug.portal_visual_alignment = portalVisualAlignment || null;
      // the seamless spatial aperture render + takeover
      // evidence (per-portal records, entity camera-space positions, avatar
      // proxies, takeover bookkeeping).
      debug.portal_spatial_preview = sceneRuntimeController.portalDebug();
      updateClientDebugCard(debug);
      mirrorDataset(debug);
      return debug;
    },
    // continuity-proof helper — a world-space point in
    // the LIVE scene camera's space (the e2e compares this after arrival with
    // the aperture camera-space sample recorded before the crossing).
    cameraSpaceOfPoint: (p) => sceneRuntimeController.cameraSpaceOfPoint(p),
    // P3: what the exit-distance parity step actually applied on the
    // last crossing (entry/applied/parity standoffs, fallback tripwire, edge).
    exitPoseParity: () => lastExitPoseParity,
    // what the heading/basis continuity step actually applied on the
    // last crossing (traversed-edge reframe record, heading contract, and the
    // measured post-seed movement basis + camera yaw).
    crossingHeadingContinuity: () => lastCrossingHeadingContinuity,
    // P4: the handoff phases this window actually observed (one entry
    // per transition; the departed-tick truth for the takeover oracle).
    phaseLog: () => observedPhaseLog.map((entry) => ({ ...entry })),
    liveAuthoredScene: () => sceneRuntimeController.liveAuthoredScene(),
    // through-ring material-truth probe — read back the
    // aperture render-target texels where given DESTINATION world points
    // project through the glued camera (the machine check that Location A
    // reads BLUE through the ring, not black). worldPoints: [{position:[x,y,z],
    // label}] or bare [x,y,z] arrays.
    samplePortalApertureTexels: (portalKey, worldPoints) =>
      sceneRuntimeController.samplePortalApertureTexels(portalKey, worldPoints),
    equipmentReady: () => !equipmentLayer || equipmentLayer.isSettled(),
    // RENDERED peer-avatar layers (the actual co-present
    // player avatars this window draws), keyed by peer client_id. Proves a real
    // second avatar exists in the scene, distinct from this client's own.
    peerAvatars: () =>
      Array.from(peerAvatarLayers.entries()).map(([clientId, layer]) => ({
        client_id: clientId,
        player_id: layer && layer.__peerPlayerId ? layer.__peerPlayerId : clientId,
        rendered: !!(layer && layer.avatarRig && layer.avatarRig.visible),
        settled: layer && typeof layer.isSettled === "function" ? layer.isSettled() : null,
        position: layer && layer.avatarRig
          ? [
              Number(layer.avatarRig.position.x.toFixed(4)),
              Number(layer.avatarRig.position.y.toFixed(4)),
              Number(layer.avatarRig.position.z.toFixed(4)),
            ]
          : null,
        rotation_y: layer && layer.avatarRig ? Number(layer.avatarRig.rotation.y.toFixed(6)) : null,
        avatar_variant: layer && layer.status ? layer.status.avatar_variant : null,
        visual_separation: layer ? layer.__peerVisualSeparation || null : null,
        attached_item_count: layer && typeof layer.debugState === "function" ? layer.debugState().attached_item_count : null,
      })),
    peerAvatarCount: () => peerAvatarLayers.size,
    controlState: movementCameraController.controlState(),
    movementDebug: () => movementCameraController.movementDebug(),
    moveAvatar: (input, dt = 0.1) => adapter.stepAvatar(input || {}, dt),
    activatePortal: () => adapter.activatePortal(),
    triggerHandoff: () => adapter.triggerHandoff(),
    applyArrival: (pkt) => adapter.applyArrival(pkt),
    // Web of Worlds API panel surface for the e2e driver.
    wowApi: panelTruthChromeController.wowApiDriver(),
    panelGroups: panelTruthChromeController.groupDriver(),
    chrome: panelTruthChromeController.chromeDriver(),
    // step 5: runtime avatar-switch + dynamic-equip surface
    // (used by the player UI buttons and the headless capture driver).
    switchAvatar: (variant) =>
      variant ? adapter.setAvatarVariant(variant) : adapter.toggleAvatarVariant(),
    equipItem: (itemId) => adapter.equipCatalogItem(itemId),
    equippableCatalog: () => adapter.equippableCatalog(),
    // staged avatar/equipment selector modal. These hooks
    // drive the same DOM modal the player uses; apply is the only live mutation.
    avatarSelector: {
      ...avatarSelectorController.selectorDriver(),
      removeAllEquipment: avatarSelectorRemoveAllEquipment,
    },
    // inventory/avatar-picker drive for headless
    // capture — same code path as the panel chips.
    inventory: avatarSelectorController.inventoryDriver(),
    storefrontShopping: storefrontShoppingController.driver(),
    airportBoarding: boardingJourneyController.driver(),
    // head-bar removal evidence — scan the equipment
    // layer's scene graph. Marker GROUPS must still exist (the equipment
    // visual-marker system stays intact) while no wide bar-shaped primitive
    // (the old 0.72 m visor box) remains under any of them.
    equipmentSceneScan: () => {
      // scan the AVATAR RIG, not `.scene` — in shared-scene mode `.scene`
      // is the whole WORLD, whose 12 m wall planes would read as "wide bars". The
      // rig subtree is exactly the graph this scan was always about (avatar +
      // bone-attached equipment + markers), in both compositing modes.
      if (!equipmentLayer || !equipmentLayer.avatarRig) return null;
      const out = { marker_groups: 0, marker_meshes: 0, wide_bar_meshes: 0, wide_bar_names: [] };
      const underMarker = (node) => {
        for (let p = node; p; p = p.parent) {
          if (p.name && p.name.startsWith("visible-equipment-marker-")) return true;
        }
        return false;
      };
      equipmentLayer.avatarRig.traverse((node) => {
        if (node.name && node.name.startsWith("visible-equipment-marker-")) out.marker_groups += 1;
        if (!node.isMesh) return;
        if (underMarker(node)) out.marker_meshes += 1;
        const params = node.geometry && node.geometry.parameters ? node.geometry.parameters : null;
        if (params && Number(params.width) >= 0.5) {
          out.wide_bar_meshes += 1;
          out.wide_bar_names.push(node.name || (node.parent && node.parent.name) || "unnamed");
        }
      });
      return out;
    },
    // depth-order probe — the rig ROOT of the local player's avatar and of the
    // first co-present peer's avatar, plus the renderer each one belongs to. Lets a proof
    // READ the actual material depth flags (transparent/opacity/depthTest/depthWrite/
    // renderOrder) on both avatars at the moment an inversion is on screen, instead of
    // reasoning about what they ought to be — and lets it confirm whether the two avatars
    // share a renderer (and therefore a depth buffer) at all.
    __depthProbeLayers: () => {
      const firstPeer = peerAvatarLayers.values().next().value || null;
      return {
        local: equipmentLayer ? equipmentLayer.avatarRig : null,
        peer: firstPeer ? firstPeer.avatarRig : null,
        same_renderer:
          !!equipmentLayer && !!firstPeer && equipmentLayer.renderer === firstPeer.renderer,
        same_scene: !!equipmentLayer && !!firstPeer && equipmentLayer.scene === firstPeer.scene,
        local_canvas: equipmentLayer && equipmentLayer.renderer ? equipmentLayer.renderer.domElement : null,
        peer_canvas: firstPeer && firstPeer.renderer ? firstPeer.renderer.domElement : null,
      };
    },
    // per-frame rig sample — raw bone world/avatar-local transforms plus each
    // equipped item's distance to the RAW bone it claims to hang off. The locomotion
    // and bone-attachment proofs assert on a TIME SERIES of these, so a frozen skeleton
    // or a floating item cannot pass. See AvatarEquipmentLayer#rigProbe.
    rigProbe: () => (equipmentLayer ? equipmentLayer.rigProbe() : null),
    avatarVisualState: () =>
      equipmentLayer
        ? {
            avatar_variant: equipmentLayer.status.avatar_variant,
            avatar_variant_label: equipmentLayer.status.avatar_variant_label,
            avatar_switch_count: equipmentLayer.status.avatar_switch_count,
            avatar_switch_in_flight: equipmentLayer.status.avatar_switch_in_flight,
            avatar_model_height_m: equipmentLayer.status.avatar_model_height_m,
            avatar_head_height_m: equipmentLayer.status.avatar_head_height_m,
            attached_items: equipmentLayer.status.attachedItems,
            locomotion_clips: equipmentLayer.status.locomotion_clips,
            current_animation_state: equipmentLayer.status.current_animation_state,
            run_calibration: { ...equipmentLayer.status.run_calibration },
          }
        : null,
    // deterministic drive/read surface for the same visible controls.
    // It is null on observer views because only the embodied player owns motion.
    runtimeTweaks: runtimeTweakController
      ? {
          open: () => runtimeTweakController.open(),
          close: () => runtimeTweakController.close(),
          set: (key, value) => runtimeTweakController.setValue(key, value),
          reset: (key) => runtimeTweakController.resetValue(key),
          resetAll: () => runtimeTweakController.resetAll(),
          copyRow: (key) => runtimeTweakController.copyRow(key),
          copyAll: () => runtimeTweakController.copyAll(),
          resizeTo: (width, height) => runtimeTweakController.resizeTo(width, height),
          snapshot: () => runtimeTweakController.snapshot(),
          setClipboardWriterForTest: (writer) => runtimeTweakController.setClipboardWriterForTest(writer),
        }
      : null,
    // first/third-person camera toggle drive + state.
    cameraMode: () => movementCameraController.playerCameraMode(),
    setCameraMode: (mode) => movementCameraController.setPlayerCameraMode(mode),
    toggleCameraMode: () => movementCameraController.togglePlayerCameraMode(),
    // server-view (observer) top-down/third-person
    // camera drive + state (null in the player window).
    serverViewMode: () => movementCameraController.serverViewMode(),
    setServerViewMode: (mode) => movementCameraController.setServerViewMode(mode),
    toggleServerViewMode: () => movementCameraController.toggleServerViewMode(),
    serverViewCameraState: () => movementCameraController.serverViewCameraState(),
    // movement-basis + visual-grounding evidence.
    movementBasisYaw: () => (isPlayer ? movementCameraController.movementBasisYaw() : null),
    groundingState: () => movementCameraController.groundingState(),
    // deterministic orbit-camera drive for headless capture.
    orbitCamera: (dAzimuth = 0, dPolar = 0, dDistance = 0) =>
      movementCameraController.orbitBy(dAzimuth, dPolar, dDistance),
    orbitCameraState: () => movementCameraController.orbitState(),
    cameraWallOcclusionState: () => movementCameraController.cameraWallOcclusionState(),
    setCameraWallFault: (arm = null) => {
      cameraWallFault = cameraWallFaultArms.has(arm) ? arm : null;
      movementCameraController.applyPlayerCamera();
      return cameraWallFault;
    },
    refreshPreviewReadOnlyState: () => adapter.refreshPreviewReadOnlyState(),
    reset: async () => {
      movementCameraController.reset();
      boardingJourneyController.reset("new_session");
      return adapter.reset();
    },
    returnToLobby: () => adapter.returnToLobby(),
    returnLobbyButtonState: () => {
      const btn = $("btn-return-lobby");
      return btn
        ? {
            hidden: btn.hidden === true,
            disabled: btn.disabled === true,
            title: btn.getAttribute("title"),
            aria_label: btn.getAttribute("aria-label"),
          }
        : null;
    },
    semanticDestinations: {
      open: () => semanticDestinationsController.open(),
      close: () => semanticDestinationsController.close(),
      activate: (key) => semanticDestinationsController.activate(key),
      snapshot: () => semanticDestinationsController.snapshot(),
    },
    phase: () => adapter.state.phase,
    dispose: disposeApplication,
    ready: true,
  };
  demoTrajectoryTool = mountDemoTrajectoryTool({
    view: window,
    document,
    role,
    snapshot: () => canonicalDebugState(adapterVisualDebugState()),
  });
  if (demoTrajectoryTool) window.__assembly.demoTrajectory = demoTrajectoryTool;
  applyLiveViewport(true);
  // portal-render-proof drive/read surface for the headless
  // probe (attach-point versions, mesh mirrors, panel state).
  window.__assembly.portalRender = portalRenderController.driver();
  // through-portal loading probe surface (tracking state,
  // notification record, destination pointer names, consent, honesty
  // descriptor; card_removed:true). Demonstration-only.
  window.__assembly.featurePortalLoading = featurePortalLoadingDriverApi();
  // notification-center shell read surface (the
  // notification center + e2e driver consume this).
  window.__assembly.notifications = {
    list: () => notificationToastController.snapshot(),
    count: () => notificationToastController.count(),
    open: (id) => openNotificationCenter(id),
    close: () => closeNotificationCenter(),
    selected: () => notificationToastController.selected(),
    isOpen: () => notificationToastController.isOpen(),
  };
  // `mission=denver-skyport` now opens the real lobby journey. Portal C is a
  // physical server-backed crossing; the launcher no longer bypasses its
  // prefetch, presence transfer, arrival, or reciprocal return contract.
  if (isPlayer && launcherMissionParam === "denver-skyport") {
    document.body.setAttribute("data-denver-skyport-mission", "portal-c-server-backed");
  }
  document.body.setAttribute("data-assembly-ready", "1");
  mirrorDataset(window.__assembly.debugState());
  if (isPlayer) {
    const navigator = adapter.debugState().navigator;
    if (navigator && (navigator.status === "root_fabric_unavailable" || navigator.status === "child_fabric_unavailable")) {
      const rootUnavailable = navigator.status === "root_fabric_unavailable";
      const failure = rootUnavailable ? navigator.root_fabric : navigator.child_fabric;
      setConnectionPresentation(
        "unavailable",
        `${failure && failure.error ? failure.error : navigator.status}. The current live world remains active.`,
        {
          kind: rootUnavailable ? "navigator_root_unavailable" : "navigator_child_unavailable",
          source_state: navigator.status,
          current: "live-world-projection",
          recovery: {
            kind: "return",
            label: "Continue in current world",
            aria_label: "Continue in the current live world",
            note: "Keeps the current live world; the unavailable fabric is not presented as loaded.",
            success_detail: "The current live world remains active; the unavailable fabric was not presented as loaded.",
            current: "live-world-projection",
          },
        }
      );
    }
  }
}

/**
 * reconcile the set of peer-player avatar layers against the
 * adapter's co-present peer list. Creates a layer for each newly co-present
 * peer, feeds every co-present peer its live pose (position/yaw/variant/equip/
 * locomotion) through the SAME AvatarEquipmentLayer.setAvatar path this
 * client's own avatar uses, and disposes layers for peers that left this world
 * (crossed away) or went silent. Player views exclude self in the adapter;
 * observer/server views receive one record per same-location player.
 *
 * INVARIANTS (one avatar PER player, no ghost/self-dup):
 *  - keyed by peer client_id → exactly one layer per peer, never two;
 *  - the adapter already excludes this window's own client_id, so a player can
 *    never render itself as a peer (no self-duplication);
 *  - a peer only renders while co_present (same world); on a crossing the peer
 *    drops out of the co-present list and its layer is disposed at once;
 *  - peer layers are SEPARATE from equipmentLayer, so this client's own
 *    local_visible_avatar_count / one-avatar invariant is unaffected.
 */
function syncPeerAvatars(dbg) {
  const peers = Array.isArray(dbg.peer_players) ? dbg.peer_players : [];
  const coPresent = peers.filter((p) => p && p.co_present && p.client_id);
  const liveIds = new Set(coPresent.map((p) => p.client_id));

  // Dispose layers whose peer is no longer co-present here (crossed away, went
  // silent, or closed its tab) — leaves no ghost avatar behind.
  for (const [clientId, layer] of peerAvatarLayers) {
    if (!liveIds.has(clientId)) {
      try { layer.dispose(); } catch {}
      peerAvatarLayers.delete(clientId);
      logLine(`co-presence: peer ${clientId.slice(0, 18)}… left this world — peer avatar removed`);
    }
  }

  for (let peerIndex = 0; peerIndex < coPresent.length; peerIndex += 1) {
    const peer = coPresent[peerIndex];
    // Shape the peer pose as an avatar snapshot for setAvatar (same fields the
    // local avatar carries). transition_visual controls spin/scale/visibility
    // so a peer walking through a portal animates identically in this view.
    const peerAvatar = playerViewSeparatedPeerAvatar({
      avatar_id: peer.avatar_id,
      continuity_id: peer.continuity_id,
      display_name: peer.display_name,
      position: peer.position,
      rotation_y: peer.rotation_y,
      avatar_variant: peer.avatar_variant,
      equippedItems: peer.equippedItems,
      locomotion: peer.locomotion,
      transition_visual: peer.transition_visual,
    }, peerIndex);
    let layer = peerAvatarLayers.get(peer.client_id);
    if (!layer) {
      // Reuse the exact avatar/equipment render path; the peer layer shares the
      // scene mount (transparent overlay canvas) and this window's camera. The
      // VRM loads async — stash the latest pose and apply it once the layer is
      // ready (so equipment attaches to the loaded rig), then feed live updates.
      // the peer rig is parented into the SAME world scene as the local
      // avatar — one depth buffer decides who occludes whom, not DOM order.
      layer = new AvatarEquipmentLayer($("scene-mount"), role, adapter.world, {
        host: avatarLayerHost(),
        motionPreference,
      });
      layer.__isPeer = true;
      layer.__latestPeerAvatar = peerAvatar;
      // correct-avatar-from-first-frame (no default->correct flicker).
      //
      // AvatarEquipmentLayer takes no variant at construction, and its _init()
      // synchronously kicks off a DEFAULT_AVATAR_VARIANT model load (it reads
      // status.avatar_variant, which stays the default until a switch lands; the
      // layer is owned by a separate lane and is not ours to change). The peer's
      // REAL variant is already known HERE at frame 0 — it rides every
      // player-pose broadcast as peer.avatar_variant and survives a crossing
      // (traversal packet avatar_context.avatar_variant, merged at arrival). So
      // the flicker the user saw across a crossing was purely a REVEAL-ORDER
      // defect: the old path primed layer.avatar immediately (letting _init's
      // _syncAvatarTransform reveal the DEFAULT rig) and, on ready, called
      // setAvatar (which reveals) and only THEN kicked off the async switch to
      // the correct variant -> visible default, then swap.
      //
      // Fix: keep the peer rig HIDDEN (leave layer.avatar null so _init's
      // _syncAvatarTransform holds avatarRig.visible=false) until the peer's OWN
      // variant is the ACTIVE model, then reveal. switchAvatarVariant loads and
      // adopts the correct model WITHOUT touching visibility, so the swap happens
      // off-screen and the FIRST visible frame is already correct. No eager
      // preloading: the only loads are the default the un-editable layer
      // forces plus the peer's own variant — the exact fetch set the pre-fix
      // reveal-then-switch path already paid, just reordered before first paint.
      layer.__variantPrimed = false;
      layer.ready.then(async () => {
        if (peerAvatarLayers.get(peer.client_id) !== layer) return;
        const latest = layer.__latestPeerAvatar || peerAvatar;
        const wantVariant = latest && latest.avatar_variant;
        if (
          wantVariant &&
          AVATAR_VARIANTS[wantVariant] &&
          wantVariant !== layer.status.avatar_variant
        ) {
          try { await layer.switchAvatarVariant(wantVariant); } catch {}
        }
        if (peerAvatarLayers.get(peer.client_id) !== layer) return;
        layer.__variantPrimed = true;
        layer.setAvatar(layer.__latestPeerAvatar || peerAvatar);
      });
      peerAvatarLayers.set(peer.client_id, layer);
      logLine(`co-presence: peer ${peer.client_id.slice(0, 18)}… co-present in ${peer.location_id} — rendering peer avatar`);
    }
    layer.__latestPeerAvatar = peerAvatar;
    layer.__peerPlayerId = peer.player_id || peer.client_id;
    layer.__peerVisualSeparation = peerAvatar.visual_separation || null;
    // don't reveal/refresh from the per-tick stream until the peer's own
    // variant has been primed as the active model — a setAvatar here before
    // priming would reveal the DEFAULT rig and re-introduce the flicker.
    if (layer.__variantPrimed && layer.isSettled && layer.isSettled()) layer.setAvatar(peerAvatar);
  }
}

// the "Spatial fabric prefetch" HUD card + body dataset
// mirror + the one-shot "Destination loaded" toast on idle->warm. Name-value
// rows per the panel-layout guidance; player view only; never blocks.
let lastFabricPrefetchStatus = null;
// per-portal warm-toast transition memory (the focus
// projection can flip between machines; toasts key on real machine warmth).
const lastFabricPrefetchStatusByPortal = {};
// background-completion terminal-state memory. On the
// running->complete transition a NOTIFICATION RECORD publishes (history +
// click-through); deliberately NO toast — the single-slot toast stack is
// showing the ARRIVED headline right after a crossing and completion must
// enrich the record trail, not stomp the toast.
let lastFabricCompletionRecordedFor = null;

function publishFabricCompletionNotification(completion) {
  if (!completion || !completion.reconciliation) return;
  const recordKey = `${completion.handoff_id || "no-handoff"}:${completion.status}`;
  if (lastFabricCompletionRecordedFor === recordKey) return;
  if (completion.status !== "complete" && completion.status !== "complete_with_mismatch") return;
  lastFabricCompletionRecordedFor = recordKey;
  publishNotificationRecord({
    id: `fabric-completion-${completion.handoff_id || "no-handoff"}`,
    kind: "fabric_completion",
    event_type: "fabric_completion_reconciled",
    status: completion.status,
    title: "background fabric completion",
    summary:
      `${completion.location_id} · +${completion.entities_added} entities in background · ` +
      `${completion.reconciliation.received_unique_entities}/${completion.reconciliation.expected_fabric_entities} ` +
      `${completion.reconciliation.match ? "reconciled" : "MISMATCH"} · ` +
      `${completion.reconciliation.duration_ms} ms · input during completion: ` +
      `${completion.reconciliation.input_during_completion.movement_samples} movement samples`,
    created_at: completion.started_at,
    updated_at: completion.completed_at || new Date().toISOString(),
    destination: { location_id: completion.location_id, fabric_id: completion.fabric_id },
    completion: {
      status: completion.status,
      pacing_ms: completion.pacing_ms,
      chunk_count: completion.chunk_count,
      entities_added: completion.entities_added,
      reconciliation: completion.reconciliation,
      origin_prefetch: completion.origin_prefetch,
    },
    claim_boundary: {
      application_level: true,
      roi_standard_conformance: false,
      standards_conformance: false,
    },
  });
}

function updateFabricPrefetchCard(dbg) {
  const card = $("fabric-prefetch-card");
  if (!card) return;
  const fp = dbg ? dbg.fabric_prefetch : null;
  document.body.setAttribute("data-fabric-prefetch-status", fp ? fp.status : "none");
  document.body.setAttribute(
    "data-fabric-prefetch-supported",
    fp && fp.supported ? "true" : "false"
  );
  const totals = fp && fp.region ? fp.region.totals : null;
  document.body.setAttribute(
    "data-fabric-prefetch-region-entities",
    totals && totals.region_entities != null ? String(totals.region_entities) : ""
  );
  document.body.setAttribute(
    "data-fabric-prefetch-fabric-entities",
    totals && totals.fabric_entities != null ? String(totals.fabric_entities) : ""
  );
  if (!fp || !fp.supported || !isPlayer) {
    card.hidden = false;
    writeDebugText("fx-status", !isPlayer ? "not active in observer view" : "not supported by this world");
    writeDebugText("fx-address", "—");
    writeDebugText("fx-last-event", "waiting for a supported player destination");
    lastFabricPrefetchStatus = fp ? fp.status : null;
    return;
  }
  card.hidden = false;
  writeDebugText("fx-status", fp.status);
  writeDebugText("fx-address", fp.address ? fp.address.uri : "—");
  const zones = fp.zones || {};
  writeDebugText(
    "fx-zone",
    zones.prefetch
      ? `r=${fixed3(zones.prefetch.radius_m)} m · avatar ${fixed3(fp.zone && fp.zone.distance_m)} m · ${
          fp.zone && fp.zone.inside ? "INSIDE" : "outside"
        }`
      : "—"
  );
  writeDebugText(
    "fx-trigger",
    zones.traversal
      ? `oval ${fixed3(zones.traversal.width_m)}×${fixed3(zones.traversal.height_m)} m · depth ${fixed3(
          zones.traversal.trigger_depth_m
        )} m · commits traversal`
      : "—"
  );
  // the region line carries the progressive-streaming
  // story — chunk count while complete, live chunk progress mid-stream.
  const fxProgressive = fp.region ? fp.region.progressive : null;
  const fxStreaming = fp.region && fp.region.streaming ? fp.region.streaming : null;
  writeDebugText(
    "fx-region",
    totals
      ? `${totals.region_entities} of ${totals.fabric_entities} entities (excluded ${totals.excluded_entities}) · r=${
          fp.region.region ? fixed3(fp.region.region.radius_m) : "?"
        } m${
          fxProgressive && fxProgressive.mode === "chunked"
            ? ` · ${fxProgressive.chunk_count} chunks near→far`
            : ""
        }`
      : fxStreaming
        ? `streaming chunk ${fxStreaming.chunks_loaded} · ${fxStreaming.entity_count} entities so far (near ring first)`
        : "—"
  );
  writeDebugText(
    "fx-region-age",
    fp.region && fp.region.age_ms != null
      ? `${(fp.region.age_ms / 1000).toFixed(1)}s old · ttl ${(fp.region.ttl_ms / 1000).toFixed(0)}s`
      : "—"
  );
  // the widened matching destination-side circle + the
  // registered avatars inside it, and the live spatial aperture state.
  const fxAvatars = fp.region ? fp.region.avatars : null;
  const fxMatch =
    zones.prefetch && zones.prefetch.matching_destination_circle
      ? zones.prefetch.matching_destination_circle
      : null;
  writeDebugText(
    "fx-dest-circle",
    fxAvatars
      ? `r=${fixed3(fxAvatars.circle ? fxAvatars.circle.radius_m : null)} m · ${
          fxAvatars.avatars_in_circle
        } avatar${fxAvatars.avatars_in_circle === 1 ? "" : "s"} inside${
          fxAvatars.avatars_in_circle
            ? ` (${(fxAvatars.avatars || [])
                .map((a) => a.display_name || a.player_id)
                .join(", ")})`
            : ""
        }${fxMatch && fxMatch.matches_source_circle ? " · matches outer circle" : ""}`
      : fxMatch
        ? `r=${fixed3(fxMatch.radius_m)} m · loads on warm · includes avatars`
        : "—"
  );
  const portalRuntimeDebug = sceneRuntimeController.portalDebug();
  const fxSpatial =
    window.__assembly && portalRuntimeDebug && fp.portal_key
      ? (portalRuntimeDebug.records || {})[fp.portal_key] || null
      : null;
  writeDebugText(
    "fx-aperture-render",
    fxSpatial && fxSpatial.active
      ? `spatial window · ${fxSpatial.entity_mesh_count} entities · ${fxSpatial.avatar_proxy_count} avatars · ${fxSpatial.render_target.width}×${fxSpatial.render_target.height}`
      : "inactive (falls back to labeled snapshot ladder)"
  );
  const occupancy = fp.presence ? fp.presence.occupancy : null;
  writeDebugText(
    "fx-occupancy",
    occupancy
      ? `${(occupancy.avatars || []).map((a) => a.display_name || a.avatar_id).join(", ") || "none"} · arrivals ${
          occupancy.arrival_count
        } · live ${occupancy.live_subscriber_count}`
      : "—"
  );
  writeDebugText(
    "fx-presence-age",
    fp.presence && fp.presence.age_ms != null
      ? `${(fp.presence.age_ms / 1000).toFixed(1)}s old · refreshes ${fp.presence.refresh_count}`
      : "—"
  );
  const lastEvent = Array.isArray(fp.events) && fp.events.length ? fp.events[fp.events.length - 1] : null;
  writeDebugText("fx-last-event", lastEvent ? `${lastEvent.event} @ ${lastEvent.at}` : "—");
  // cache accounting + background completion rows.
  const fxCache = fp.keyed && fp.keyed.cache ? fp.keyed.cache : null;
  writeDebugText(
    "fx-cache",
    fxCache
      ? `${fxCache.total_bytes} of ${fxCache.cap_bytes} B cached · evictions ${fxCache.eviction_count}${
          fxCache.cap_source === "query_param_fixture" ? " · cap=fixture" : ""
        }`
      : "—"
  );
  const fxCompletion = fp.completion || null;
  writeDebugText(
    "fx-completion",
    fxCompletion
      ? `${fxCompletion.status} · ${fxCompletion.chunk_count} chunks · +${fxCompletion.entities_added} entities${
          fxCompletion.reconciliation
            ? ` · ${fxCompletion.reconciliation.received_unique_entities}/${fxCompletion.reconciliation.expected_fabric_entities}${
                fxCompletion.reconciliation.match ? " reconciled" : " MISMATCH"
              }`
            : ""
        }`
      : "—"
  );
  publishFabricCompletionNotification(fxCompletion);
  // notifications publish from EVERY keyed machine (a
  // single-portal world's keyed map is exactly its one machine, so pre-004
  // behavior is unchanged), and the warm toast fires per MACHINE transition —
  // the top-level focus projection can flip between machines as the player
  // walks, which must never fake a "Destination loaded" beat.
  const keyed = fp.keyed || null;
  const keyedMachines =
    keyed && keyed.machines && Object.keys(keyed.machines).length
      ? keyed.machines
      : { [fp.portal_key || "primary"]: fp };
  for (const machineKey of Object.keys(keyedMachines)) {
    const machine = keyedMachines[machineKey];
    if (!machine || !machine.supported) continue;
    publishFabricPrefetchNotifications(machine);
    const previousStatus = lastFabricPrefetchStatusByPortal[machineKey];
    const machineTotals = machine.region ? machine.region.totals : null;
    if (machine.status === "warm" && previousStatus !== "warm" && machineTotals) {
      const machineOccupancy = machine.presence ? machine.presence.occupancy : null;
      const readyNotificationId = latestNotificationIdByKind("fabric_prefetch_event");
      showToast(
        "Destination loaded",
        `${machine.address ? machine.address.location_id : "destination"} · ${
          machineTotals.region_entities
        }/${machineTotals.fabric_entities} entities · ${
          machineOccupancy ? (machineOccupancy.avatars || []).length : 0
        } known present`,
        "toast-arrived",
        { notificationId: readyNotificationId }
      );
    }
    lastFabricPrefetchStatusByPortal[machineKey] = machine.status;
  }
  lastFabricPrefetchStatus = fp.status;
  updateFabricPrefetchPortalList(keyed);
}

// the portal-picker block inside the prefetch card —
// one stacked line per portal machine (status, distance, queued/selected
// marks) plus the per-destination occupancy read, so a lobby user can see
// where people are BEFORE choosing a portal. Hidden on single-portal worlds.
function updateFabricPrefetchPortalList(keyed) {
  const card = $("fabric-prefetch-card");
  if (!card) return;
  let host = document.getElementById("fx-portal-list");
  const multi = keyed && keyed.portal_count > 1;
  document.body.setAttribute("data-fabric-prefetch-portal-count", keyed ? String(keyed.portal_count || 0) : "0");
  document.body.setAttribute(
    "data-fabric-prefetch-budget",
    keyed && keyed.budget != null ? String(keyed.budget) : ""
  );
  document.body.setAttribute(
    "data-fabric-prefetch-max-observed-active-loads",
    keyed && keyed.max_observed_active_loads != null ? String(keyed.max_observed_active_loads) : ""
  );
  if (!multi) {
    if (host) host.hidden = true;
    return;
  }
  if (!host) {
    host = document.createElement("div");
    host.id = "fx-portal-list";
    card.appendChild(host);
  }
  host.hidden = false;
  const machines = keyed.machines || {};
  const occupancyStore = keyed.destination_occupancy || null;
  const lines = [];
  lines.push('<div class="std-sub" data-reconcile-key="portal-list-heading">portal choice — per-portal prefetch machines</div>');
  lines.push(
    `<div class="kv" data-reconcile-key="portal-list-budget"><span class="k">load budget</span><span class="v">${
      keyed.active_load_count
    }/${keyed.budget} active · max seen ${keyed.max_observed_active_loads}</span></div>`
  );
  for (const key of Object.keys(machines)) {
    const machine = machines[key];
    if (!machine) continue;
    const marks = [
      keyed.selected_portal_id === key ? "SELECTED" : null,
      machine.queued ? "QUEUED" : null,
      machine.zone && machine.zone.inside ? "in-zone" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const dest = machine.target_location_id || "?";
    const occRecord = occupancyStore && occupancyStore.destinations ? occupancyStore.destinations[key] : null;
    const occCount =
      occRecord && occRecord.occupancy
        ? (occRecord.occupancy.avatars || []).length
        : machine.presence && machine.presence.occupancy
          ? (machine.presence.occupancy.avatars || []).length
          : null;
    lines.push(
      `<div class="kv" data-reconcile-key="portal:${escapeHtml(key)}"><span class="k">${key}</span><span class="v">${
        machine.status
      } · ${dest} · ${machine.zone && machine.zone.distance_m != null ? machine.zone.distance_m + " m" : "—"}${
        occCount != null ? ` · ${occCount} there` : ""
      }${marks ? ` · ${marks}` : ""}</span></div>`
    );
  }
  reconcileKeyedHtml(host, lines.join(""));
}

function onState(dbg) {
  const phase = dbg.phase;
  // P4: page-truth phase-transition log. Records every handoff phase
  // this window actually OBSERVED (an adapter emit processed by onState) —
  // the honest oracle for emit-coalesced atomic crossings: when the whole
  // departed->promoted transfer lands inside one dispatch, no
  // departed tick ever reaches the page, so nothing could or should have
  // armed the takeover. Consumed by the e2e battery via __assembly.phaseLog().
  if (phase !== lastObservedPhase) {
    observedPhaseLog.push({ phase, at_ms: Date.now() });
    if (observedPhaseLog.length > 64) observedPhaseLog.shift();
    lastObservedPhase = phase;
  }
  scene.setPhase(phase);
  scene.setAvatar(null);
  // only an embodied player renders dbg.avatar as its
  // self-avatar. Source/target observers render keyed co-present players below;
  // using the hosted compatibility avatar as an observer fallback depicted one
  // player even when the authoritative presence registry was empty.
  if (equipmentLayer) equipmentLayer.setAvatar(isPlayer ? dbg.avatar : null);
  // render/refresh peer-player avatars.
  syncPeerAvatars(dbg);
  // the same keyed high-frequency peer-pose records feed eligible
  // full-fidelity avatars inside each portal destination circle.
  sceneRuntimeController.syncPortalPeers(dbg.peer_players);
  if (!isPlayer && dbg.live_player_pose && dbg.live_player_pose.applied_count === 1) {
    logLine(
      `live player pose mirror active: tracking ${dbg.live_player_pose.from_client_id || "player"} ` +
        `in ${dbg.live_player_pose.location_id} (render-only; no backend mutation)`
    );
  }
  const canonical = canonicalDebugState(dbg);
  semanticDestinationsController.update({
    world: adapterVisualRuntimeSnapshot()?.world || null,
    debug: canonical,
    connectionState: connectionPresentation.state,
    isPlayer,
  });
  updateClientDebugCard(canonical);
  mirrorDataset(canonical);
  syncReturnLobbyButton(canonical);
  storefrontShoppingController.observe({
    locationId: canonical.location_id || dbg.location_id,
    avatarPosition: dbg.avatar?.position || null,
    airportTerminal: sceneRuntimeController.liveAuthoredScene()?.airport_terminal || null,
  });
  boardingJourneyController.observe({
    locationId: canonical.location_id || dbg.location_id,
    avatarPosition: dbg.avatar?.position || null,
    airportTerminal: sceneRuntimeController.liveAuthoredScene()?.airport_terminal || null,
  });
  movementCameraController.observeState(phase);
  const previewSurface = updatePortalPreviewSurface(canonical);
  if (previewSurface) {
    portalVisualAlignment = { ...(portalVisualAlignment || {}), preview_surface: previewSurface };
    canonical.portal_visual_alignment = portalVisualAlignment;
  }

  // warm-crossing TAKEOVER. While a warm crossing
  // commits (departed -> promotion, tens of ms), the ring's destination
  // render — the same mapped texture the aperture was already showing —
  // covers the whole viewport, so the scene the promotion lands in is the
  // scene already on screen. Never engages on cold crossings; disengages the
  // moment the phase leaves `departed` without a promotion (rejection/abort).
  if (isPlayer) {
    if (phase === HANDOFF_PHASES.DEPARTED) {
      const crossingKey = canonical.fabric_prefetch ? canonical.fabric_prefetch.portal_key : null;
      if (crossingKey) sceneRuntimeController.engagePortalTakeover(crossingKey);
    } else if (sceneRuntimeController.portalTakeoverEngaged()) {
      sceneRuntimeController.disengagePortalTakeover();
    }
  }
  const pl = PHASE_LABEL[phase] || { text: phase };
  $("phase-pill").textContent = pl.text;
  renderOverlay(phase, canonical);
  // fabric prefetch HUD card + zone ring (player only;
  // both no-op gracefully when the backend serves no portal address).
  updateFabricPrefetchCard(canonical);
  ensureFabricPrefetchZoneRing(canonical);

  const av = dbg.avatar;
  $("a-id").textContent = av ? av.avatar_id : "—";
  $("a-cont").textContent = av ? av.continuity_id : "—";
  $("a-name").textContent = av ? av.display_name : "—";
  $("a-src").textContent = av && av.source_location_id ? av.source_location_id : (role !== "target" ? dbg.location_id : "—");
  $("h-id").textContent = dbg.handoff_id || "—";
  $("h-count").textContent = dbg.session.arrival_count;
  renderEquipment(dbg.equipment_status, av);
  avatarSelectorController.updateInventorySelection(dbg); // legacy compatibility projection
  updateMovementDebug(canonical);
  updateGeoPoseDebug(canonical); // GeoPose-shaped positioning card
  panelTruthChromeController.refresh(canonical); // standards, truth, and chrome are controller-owned.
  applyStageScenePresentation(scene && scene._impl ? scene._impl.scene : null);
  // drive the through-portal loading toast + notification
  // record off the same live debug state (crossing detection + step
  // check-marking; never throws; no-op outside the player window; the
  // center-screen card is removed). Demonstration-only.
  featureNotePortalLoadingState(canonical);
}

window.addEventListener("pagehide", disposeApplication, { once: true });
mountLiveViewportLifecycle();
setConnectionPresentation("loading", "Connecting to the live world…");
main()
  .then(() => {
    if (connectionPresentation.state === "loading") {
      setConnectionPresentation("live", "The live world contract is healthy.");
    }
  })
  .catch((err) => {
    const message = err && err.message ? err.message : String(err);
    const disconnected = (err && err.name === "TypeError" && /fetch/i.test(message)) || navigator.onLine === false;
    const failedBootState = disconnected ? "disconnected" : "error";
    setConnectionPresentation(
      failedBootState === "error" ? "unavailable" : failedBootState,
      disconnected
        ? "The local world services are not responding. Start them, then reload and retry this view."
        : `The live world could not finish loading: ${message}`,
      {
        kind: disconnected ? "boot_transport_disconnected" : "boot_runtime_unavailable",
        source_state: disconnected ? "fetch_failed" : "boot_failed",
      }
    );
    logLine(`FATAL: ${message}`);
    console.info(`[connection] handled live-world boot failure: ${message}`);
  });
