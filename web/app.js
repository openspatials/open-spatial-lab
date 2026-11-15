import { bootLive, bootWow, requireActiveBoot } from "./application-boot.mjs";
import { createApplicationDriver } from "./application-driver.mjs";
import { publishExitPose } from "./crossing-presentation.mjs";
import { createApplicationStatusPanel } from "./application-status-panel.mjs";
import { createFabricNotificationPublisher } from "./fabric-notification-publisher.mjs";
import { createLiveViewportController } from "./live-viewport-controller.mjs";
import {
  fixed3,
  vec3Label,
  yawQuaternion,
  escapeHtml,
} from "./application-debug-format.mjs";
import { createDebugWriter } from "./application-debug-writer.mjs";
import { canonicalDebugState as projectApplicationDebug } from "./application-debug-projection.mjs";
import { publishDebugDataset } from "./application-debug-dataset.mjs";
import { createApplicationMotionPanel } from "./application-motion-panel.mjs";
import { createApplicationWorldPanel } from "./application-world-panel.mjs";
import { createApplicationPrefetchPanel } from "./application-prefetch-panel.mjs";
import { createThreeCameraBridge } from "./three-camera-bridge.mjs";
import { createThreeWorldPresentation } from "./three-world-presentation.mjs";
import { createThreePortalSurfaces } from "./three-portal-surfaces.mjs";
import {
  setLayerRecursive,
  CHILD_FABRIC_LAYER,
} from "./three-fabric-presentation.mjs";
import { alignPortalVisualToTrigger } from "./three-portal-outline.mjs";
import { LiveAdapter, API_EVENTS } from "./live-adapter.js?v=runtime";
import {
  AvatarEquipmentLayer,
  AVATAR_VARIANTS,
  cloneGltfSceneAsset,
  loadGltfSceneAsset,
} from "./avatar-equipment-layer.js";
import { buildWowScene, mountWowSceneAssets } from "./wow-scene.mjs";
import { presentHandshake, variantForUri } from "./wow-handshake-mount.mjs";
import { createMainDemoWiring } from "./main-demo-wiring.mjs";
import { followFooterHeight } from "./main-demo-footer.mjs";
import { ringColorsOf, WORLDS, X3D_PORTALS } from "./worlds-list.mjs";
import { resolveBoundedPreview } from "./main-demo-portals.mjs";
import { mountAirportTerminalContent } from "./airport-terminal-scene.mjs";
import {
  airportSceneContract,
  resolveClientSceneLoadTraversal,
} from "./airport-lobby-transition.mjs";
import { IWPS_CONFORMANCE } from "./iwps-query-teleport.mjs";
import { UM_CONFORMANCE } from "./conformance/um-conformance.mjs";
import {
  buildAndSignManifest as umBuildAndSignManifest,
  verifyManifestSignature as umVerifyManifestSignature,
} from "./manifest/um-manifest-emitter.mjs";
import {
  makeAvatarDefinition as umMakeAvatarDefinition,
  makeLoadingPointer as umMakeLoadingPointer,
} from "./manifest/interfaces.mjs";
import {
  initPortalLoadingOverlay as featureInitPortalLoadingOverlay,
  notePortalLoadingState as featureNotePortalLoadingState,
  buildLoadingPointersForManifest as featureBuildLoadingPointersForManifest,
  extractPortalLoadingContent as featureExtractPortalLoadingContent,
  portalLoadingDriverApi as featurePortalLoadingDriverApi,
} from "./portal-loading.mjs";
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
import { parseWorldUrl } from "./wow-url.mjs";
import { withBase, withServer, SERVER_ORIGIN } from "./base-path.mjs";
import { reconcileKeyedHtml } from "./reconcile-keyed-html.mjs";
import {
  NO_EQUIPMENT_CHOICE,
  applyNoEquipmentChoice,
} from "./no-equipment-choice.mjs";
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
import { createApplicationState } from "./application-state.mjs";
import { createRendererCapabilityPanel } from "./renderer-capability-panel.mjs";
import { chooseRenderAdapter as chooseRegisteredRenderAdapter } from "./vendor/scene-core/render-adapter/registry.mjs";
import { prepareWorld } from "./soft-body-world.mjs";
import { createSoftBodyWorld } from "./vendor/scene-core/x3d/soft-body.mjs";
import { decodeRgbe } from "./vendor/scene-core/x3d/rgbe-decoder.mjs";
import { ownX3dDocumentSelection, ownX3dEnvironmentSelection, ownX3dLightingStatus, ownX3dShellUrl, x3dDestinationUrl } from "./own-x3d-document.mjs";
import { loadOwnX3dAmmo } from "./own-x3d-ammo.mjs";
import { chooseRendererAtBoot } from "./vendor/scene-core/render-adapter/render-adapter.mjs";
import {
  expectedPortalEdgeId,
  imageLayerFlipForViewerSide,
  portalPerimeterLiveGate,
  portalSharedEdgeIdentity,
  portalViewerSide,
} from "./portal-spatial-preview.mjs?v=meeting-critical-destination";
import { fabricPortalKey as appPortalKey } from "./live-adapter-portal-geometry.mjs";
import { createMovementCameraController } from "./movement-camera-controller.mjs";
import { createMotionPreference } from "./motion-preference.mjs";
import { renderQualityLevers } from "./render-quality-levers.mjs";
import { createSemanticDestinationsController } from "./semantic-destinations-controller.mjs";
import { mountDemoTrajectoryTool } from "./demo-trajectory/trajectory-panel.mjs?v=runtime";

const params = new URLSearchParams(location.search);
const documentViewerMode = params.has("x3dDocument");
// Document route only: x3dEnvironment and x3dEnvironmentIntensity name an admitted environment (own-x3d-document.mjs).
// A refused value is kept and thrown when the route builds its renderer, so the boot fails with that message.
const x3dEnvironment = (() => {
  if (!documentViewerMode) return { selection: null, error: null };
  try {
    return { selection: ownX3dEnvironmentSelection({ file: params.get("x3dEnvironment"), intensity: params.get("x3dEnvironmentIntensity") }, withBase), error: null };
  } catch (error) { return { selection: null, error }; }
})();

/** Host environment resolver for the admitted file: fetch through the given URL with the signal, decode the RGBE. */
async function resolveX3dEnvironment(uri, { signal } = {}) {
  const admitted = x3dEnvironment.selection?.url;
  if (uri !== admitted) throw new Error(`X3D environment ${uri} is not the admitted ${admitted}`);
  const response = await fetch(uri, { signal });
  if (!response.ok) throw new Error(`X3D environment ${uri} answered ${response.status}`);
  return decodeRgbe(await response.arrayBuffer());
}

/**
 * The registry's boot-time choice. On the document route a refused environment parameter stops the renderer build
 * here, and an admitted one gives the own-X3D adapter the environment resolver; otherwise nothing changes.
 */
function chooseRenderAdapter(THREE, search, options) {
  if (x3dEnvironment.error) throw x3dEnvironment.error;
  const choice = chooseRegisteredRenderAdapter(THREE, search, options);
  if (x3dEnvironment.selection && choice.active.adapter?.kind === "own-x3d") choice.active.adapter.setEnvironmentResolver(resolveX3dEnvironment);
  return choice;
}
const portalAtomicityOracleParam =
  ["127.0.0.1", "localhost"].includes(location.hostname) &&
  ["microtask", "task", "raf", "all"].includes(
    params.get("portal_atomicity_oracle")
  )
    ? params.get("portal_atomicity_oracle")
    : null;
const motionPreference = createMotionPreference({
  view: window,
  target: document.documentElement,
});
const launcherMissionParam = params.get("mission");
function readWowUrlIntent() {
  try {
    return parseWorldUrl(location.href);
  } catch (err) {
    console.warn(
      "[wow-url] could not parse world URL; falling back to default join",
      err
    );
    return null;
  }
}
const wowUrlIntent = readWowUrlIntent();
const isWowWorldUrl = !!wowUrlIntent && wowUrlIntent.worldSource === "path";
const stageParam =
  params.get("stage") === "1" || params.get("stage") === "true";
const roleParam = params.get("role");
const role =
  documentViewerMode ? "player" : roleParam === "target"
    ? "target"
    : roleParam === "player" || (!roleParam && (stageParam || isWowWorldUrl))
    ? "player"
    : "source";
const isPlayer = role === "player";
const activeParam =
  params.get("active") || (isWowWorldUrl ? wowUrlIntent.world : "");
const wowParam = params.get("wow");
const noEquipParam =
  params.get("noequip") !== "0" && params.get("noequip") !== "false";
const playerSessionController = createPlayerSessionController({
  getStorage: () =>
    typeof sessionStorage !== "undefined" ? sessionStorage : null,
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
function resolveBootActive() {
  return playerSessionController.resolveBootActive({ isPlayer, activeParam });
}
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
          activeEndpointKey:
            visual?.activeEndpointKey || adapter.activeEndpointKey,
          activeParam,
          locationId: debug && debug.location_id ? debug.location_id : null,
          position: av && Array.isArray(av.position) ? av.position : null,
          rotationY: av ? av.rotation_y : undefined,
          orbitAzimuthRad: cameraState
            ? cameraState.orbitAzimuthRad
            : undefined,
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
function readRestorablePlayerSession() {
  return playerSessionController.readRestorable({
    isPlayer,
    activeEndpointKey: adapter ? adapter.activeEndpointKey : activeParam,
  });
}
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
  rootListenerRemovers.push(() =>
    target.removeEventListener(type, listener, options)
  );
}

function portalApertureOcclusionCandidates(impl) {
  const out = [];
  const push = (mesh) => {
    if (
      mesh &&
      mesh.isMesh &&
      mesh.userData &&
      "portalSurfaceWanted" in mesh.userData
    )
      out.push(mesh);
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
    ? movementCameraController.updatePortalOcclusion(
        position,
        target,
        cameraMode,
        {
          impl,
          candidates,
          wallCandidates,
          sceneId: impl && impl.scene ? impl.scene.uuid : null,
          worldId: adapter && adapter.world ? adapter.world.location_id : null,
        }
      )
    : null;
}

function recordPanelActivity(input) {
  if (panelTruthChromeController == null) return null;
  return assertPanelTruthChromeControllerContract(
    panelTruthChromeController
  ).recordActivity(input);
}

function logLine(msg) {
  recordPanelActivity({ message: String(msg), eventClass: "runtime" });
  console.log(`[assembly:${role}] ${msg}`);
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
    return Number.isFinite(date.getTime())
      ? date.toLocaleTimeString([], { hour12: false })
      : String(raw);
  },
  setTimer: (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: (timer) => window.clearTimeout(timer),
  escapeHtml,
  isTypingTarget,
  motionPreference,
  logger: logLine,
});

const statusPanel = createApplicationStatusPanel({
  lookup: $,
  body: document.body,
  isPlayer,
  role,
  phases: HANDOFF_PHASES,
  notifications: notificationToastController,
  getAdapter: () => adapter,
  canonicalDebugState,
  destinationLoadingContent,
  onConnectionChange: () => semanticDestinationsController?.update(),
  reload: () => location.reload(),
  listen: listenAtRoot,
});
const {
  renderOverlay,
  renderEquipment,
  setConnectionPresentation,
  handleConnectionApiRequest,
  syncReturnLobbyButton,
} = statusPanel;
const wireReturnLobbyButton = () => statusPanel.mount();
const {
  publishFabricPrefetchNotifications,
  publishFabricCompletionNotification,
} = createFabricNotificationPublisher({
  getActive: () => adapter?.active,
  publish: (record) => notificationToastController.publish(record),
});

function showToast(big, sub, cls, opts = {}) {
  notificationToastController.show(big, sub, cls, opts);
}

function applyStageScenePresentation(root) {
  return sceneRuntimeController
    ? sceneRuntimeController.hideStageDebugVisuals(root)
    : 0;
}

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

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName ? target.tagName.toLowerCase() : "";
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

const debugWriter = createDebugWriter($, document.body);
const writeDebugText = debugWriter.text;
const writeDebugBool = debugWriter.bool;
const motionDebugPanel = createApplicationMotionPanel(debugWriter);
const worldDebugPanel = createApplicationWorldPanel(debugWriter);
const prefetchDebugPanel = createApplicationPrefetchPanel(
  debugWriter,
  document,
  reconcileKeyedHtml
);

function recomposeActiveWorldScene(reason) {
  return sceneRuntimeController.recomposeLive(reason);
}

function flagCell(el, val) {
  el.textContent = String(val);
  el.classList.toggle("true", val === true);
  el.classList.toggle("false", val === false);
}

function handleOffline() {
  setConnectionPresentation(
    "disconnected",
    "No connection. This browser is offline. Reconnect, then reload and retry the current world."
  );
}

listenAtRoot(API_EVENTS, "wow-api-request", handleConnectionApiRequest);
listenAtRoot(window, "offline", handleOffline);

let adapter,
  scene,
  equipmentLayer,
  portalVisualAlignment,
  portalRenderController,
  avatarSelectorController,
  sceneRuntimeController,
  movementCameraController,
  semanticDestinationsController,
  storefrontShoppingController,
  boardingJourneyController,
  runtimeTweakController,
  demoTrajectoryTool,
  rendererCapabilityPanel;
const applicationState = createApplicationState({
  getAdapter: () => adapter,
  readRefresh: () => portalRenderController?.debug()?.refresh_settings,
});
const { ensureFabricPrefetchZoneRing, setupWorldNavigatorRender } =
  createThreeWorldPresentation({
    getScene: () => scene,
    getRuntime: applicationState.runtime,
    getSceneRuntime: () => sceneRuntimeController,
    syncPortalRing: (...args) => mainDemo.syncPortalRing(...args),
    isPlayer,
    logLine,
  });
const { updatePortalPreviewSurface } = createThreePortalSurfaces({
  getScene: () => scene,
  getRuntime: applicationState.runtime,
  getSceneRuntime: () => sceneRuntimeController,
  syncPortalRing: (...args) => mainDemo.syncPortalRing(...args),
  isPlayer,
  logLine,
});

portalRenderController = createPortalRenderController({
  describeObjects: applicationState.describeObjects,
  THREE,
  isPlayer,
  getPortalHost: () =>
    adapter
      ? {
          activeEndpointKey: adapterVisualRuntimeSnapshot()?.activeEndpointKey,
          previewEndpointKey:
            adapterVisualRuntimeSnapshot()?.previewEndpointKey,
          world: adapterVisualRuntimeSnapshot()?.world,
          demoReadAttachPoint: (key) => adapter.demoReadAttachPoint(key),
          demoReadPortalView: (key, resolution) =>
            adapter.demoReadPortalView(key, resolution),
          demoMoveSceneObject: (key, id, position) =>
            adapter.demoMoveSceneObject(key, id, position),
          demoMovePortal: (key, position) =>
            adapter.demoMovePortal(key, position),
          demoReadRepublishRate: (key) => adapter.demoReadRepublishRate(key),
          demoSetRepublishRate: (key, milliseconds) =>
            adapter.demoSetRepublishRate(key, milliseconds),
          applyHostedPortalPose: (position) =>
            adapter.applyHostedPortalPose(position),
          applyHostedTargetPortalPose: (position) =>
            adapter.applyHostedTargetPortalPose(position),
        }
      : null,
  getScene: () => scene,
  getServerViewMode: () =>
    movementCameraController ? movementCameraController.serverViewMode() : null,
  alignPortalVisualToTrigger,
  setPortalVisualAlignment: (alignment) => {
    portalVisualAlignment = alignment;
  },
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
  const base =
    typeof adapter.demoProxyBase === "function"
      ? adapter.demoProxyBase(key)
      : "";
  return { key, base, content };
}

panelTruthChromeController = assertPanelTruthChromeControllerContract(
  createPanelTruthChromeController({
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
    MutationObserverClass:
      typeof MutationObserver !== "undefined" ? MutationObserver : null,
    ResizeObserverClass: null,
    getCapabilities: () =>
      adapter
        ? {
            apiPanelInfo: () => adapter.apiPanelInfo(),
            wowResolved: () => adapter.wowResolved(),
            claimBoundary: () => adapter.claimBoundary(),
            debugState: () => (adapter.world ? adapter.debugState() : null),
            apiFetchEndpoint: (kind, id) => adapter.apiFetchEndpoint(kind, id),
            presenterExitIntent: () => adapter.presenterExitIntent(),
            presenterDeliverArrival: (packet, settings) =>
              adapter.presenterDeliverArrival(packet, settings),
            verifyViewMatchesCamera: () => adapter.verifyViewMatchesCamera(),
            wowLocalWalk: !!adapter._wowLocalWalk,
            setRp1FailClosedDemoMode: (mode) =>
              adapter.setRp1FailClosedDemoMode(mode),
            rendererKind:
              scene && scene.rendererKind ? scene.rendererKind : "three.js",
          }
        : {
            rendererKind:
              scene && scene.rendererKind ? scene.rendererKind : "three.js",
          },
    resizeSceneSurfaces: () => {
      try {
        if (sceneRuntimeController) sceneRuntimeController.resize();
      } catch {}
      try {
        if (equipmentLayer && typeof equipmentLayer.resize === "function")
          equipmentLayer.resize();
      } catch {}
      for (const layer of peerAvatarLayers().values()) {
        try {
          if (typeof layer.resize === "function") layer.resize();
        } catch {}
      }
    },
    wirePortalSettingsModal: () => portalRenderController?.wireSettingsModal(),
    buildAndSignManifest: umBuildAndSignManifest,
    verifyManifestSignature: umVerifyManifestSignature,
    makeAvatarDefinition: umMakeAvatarDefinition,
    makeLoadingPointer: umMakeLoadingPointer,
    buildLoadingPointersForManifest: featureBuildLoadingPointersForManifest,
    getDestinationLoadingContent: destinationLoadingContent,
  })
);
function refreshWowViewMatch(now) {
  return panelTruthChromeController.refreshViewMatch(now);
}
const peerAvatarLayers = () => sceneRuntimeController.peerLayers();
function adapterVisualRuntimeSnapshot() {
  return applicationState.snapshot();
}

function adapterVisualDebugState() {
  return applicationState.debugState();
}
const AVATAR_COMPOSITING_MODE = (() => {
  try {
    return new URLSearchParams(window.location.search).get(
      "avatar_compositing"
    ) === "stacked"
      ? "stacked"
      : "shared";
  } catch (e) {
    return "shared";
  }
})();

sceneRuntimeController = createSceneRuntimeController({
  THREE,
  requireExplicitAvatarResources: chooseRendererAtBoot(location.search).active.kind === "own-x3d",
  createRenderAdapter: () => chooseRenderAdapter(THREE, location.search, {
    ownX3d: { createCanvas: () => document.createElement("canvas"), preparePhysics: prepareWorld },
  }).active.adapter,
  fetchX3dDocument: (asset, options) => fetch(withBase(asset), options),
  loadX3dAmmo: ({ signal }) => loadOwnX3dAmmo({ signal, assetUrl: withBase, documentTarget: document }),
  createX3dPhysics: createSoftBodyWorld,
  readX3dViewer: state => ({ position: state.camera.position.toArray(), orientation: state.runtime.viewpoints[0].orientation,
    ...movementCameraController.documentActions() }),
  readX3dPermission: () => sceneRuntimeController.scene()?.document ? ["DEF:PortalAnchor"] : [],
  readX3dLighting: () => x3dEnvironment.selection?.lighting ?? null,
  // The document's authored portal window: the listed worlds, and the one bounded-preview loader the LiveAdapter uses.
  x3dWorlds: WORLDS,
  resolveX3dPortalDestination: entry => resolveBoundedPreview(entry, { fetch: (url, init) => fetch(url, init) }),
  onX3dIntent: (_intent, selection) => location.assign(x3dDestinationUrl(selection.destination,
    { renderer: "own-x3d", serverOrigin: SERVER_ORIGIN, withBase, withServer, locationHref: location.href })),
  applicationState,
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
  getRuntime: applicationState.runtime,
  getAvatarLayers: () => ({
    local: equipmentLayer,
    peers: peerAvatarLayers().values(),
  }),
  avatarVariants: AVATAR_VARIANTS,
  sceneRoleForDebug: activeSceneRole,
  alignPortalVisual: alignPortalVisualToTrigger,
  portalKey: appPortalKey,
  setupNavigatorRender: () => setupWorldNavigatorRender(),
  onSceneChanged: (next) => {
    scene = next;
    rendererCapabilityPanel?.refresh();
    movementCameraController?.refreshSceneHost();
    movementCameraController?.applyPlayerCamera();
    if (window.__assembly) {
      window.__assembly.scene = next;
      window.__assembly.rendererKind = next ? next.rendererKind : null;
    }
  },
  onPortalAlignment: (alignment) => {
    portalVisualAlignment = alignment;
  },
  seedOrbitCamera: (seed) => movementCameraController?.seedOrbitCamera(seed),
  applyPlayerCamera: () => movementCameraController?.applyPlayerCamera(),
  logLine,
  showToast,
  vec3Label,
});

const liveViewport = createLiveViewportController({
  windowTarget: window,
  mount: appEl,
  sceneRuntime: sceneRuntimeController,
  requestFrame: window.requestAnimationFrame.bind(window),
  cancelFrame: window.cancelAnimationFrame.bind(window),
  onResize: () => {
    equipmentLayer?.resize?.();
    for (const layer of peerAvatarLayers().values()) layer?.resize?.();
    movementCameraController?.applyPlayerCamera();
  },
});

movementCameraController = createMovementCameraController({
  documentViewer: documentViewerMode ? {
    softBody: params.get("x3dDocument") === "soft-body.x3d.json",
    entry: () => sceneRuntimeController.scene()?.entry,
    activate: event => sceneRuntimeController.activateX3dDocumentAt(event),
  } : null,
  expectedPortalEdgeId,
  cameraBridge: createThreeCameraBridge({
    THREE,
    sceneRuntime: sceneRuntimeController,
    getAvatarLayers: () => ({
      local: equipmentLayer,
      peers: peerAvatarLayers().values(),
    }),
    getRuntime: applicationState.runtime,
    logLine,
  }),
  isPlayer,
  role,
  windowTarget: window,
  documentTarget: document,
  lookup: $,
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  now: () => performance.now(),
  getRuntime: applicationState.runtime,
  sceneRuntime: sceneRuntimeController,
  getAvatarLayers: () => ({
    local: equipmentLayer,
    peers: peerAvatarLayers().values(),
  }),
  resolveClientSceneLoadTraversal,
  persistPlayerSession: (force) => persistPlayerLocationState(force),
  refreshViewMatch: (nowMs) => refreshWowViewMatch(nowMs),
  renderOrientation: () => {
    const orientation = $("state-overlay")?.querySelector(
      '[data-testid="player-first-frame"][data-connection-state="live"]'
    );
    if (!statusPanel.orientationDismissed() && orientation) {
      statusPanel.dismissOrientation(
        adapterVisualRuntimeSnapshot()?.state?.phase || HANDOFF_PHASES.IDLE,
        adapterVisualRuntimeSnapshot()?.world
          ? canonicalDebugState(adapterVisualDebugState())
          : null
      );
    }
  },
  refreshDebugProjection: () => {
    if (!adapter) return;
    const canonical = canonicalDebugState(adapterVisualDebugState());
    worldDebugPanel.render(canonical);
    publishDebugDataset(document.body, canonical, role);
  },
  updateMovementProjection: (debug, movement) =>
    updateMovementDebug(debug, movement),
  applyPortalOcclusion: (position, target, mode) =>
    updatePortalApertureOcclusion(position, target, mode),
  logLine,
  showToast,
  isTypingTarget,
  motionPreference,
});

if (isPlayer)
  rendererCapabilityPanel = createRendererCapabilityPanel({
    document,
    readAdapter: () => sceneRuntimeController.activeAdapter(),
    readAvatar: () => equipmentLayer?.status,
    readRefresh: () => portalRenderController?.debug()?.refresh_settings,
    rendererChoice: chooseRendererAtBoot(location.search),
  });

semanticDestinationsController = createSemanticDestinationsController({
  lookup: $,
  createElement: (tagName) => document.createElement(tagName),
  documentTarget: document,
  eventTarget: document,
  getSnapshot: () => ({
    world: adapterVisualRuntimeSnapshot()?.world || null,
    debug: adapterVisualRuntimeSnapshot()?.world
      ? adapterVisualDebugState()
      : null,
    connectionState: statusPanel.connectionStatus().state,
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

function avatarLayerHost() {
  return sceneRuntimeController.avatarHost();
}

avatarSelectorController = createAvatarSelectorController({
  isPlayer,
  role,
  variants: AVATAR_VARIANTS,
  inventorySlots,
  equipmentCatalog,
  validateEquippedItems,
  resolveEquipmentItems,
  noEquipmentChoice: NO_EQUIPMENT_CHOICE,
  applyNoEquipmentChoice: (items) => applyNoEquipmentChoice(items),
  createPreviewLayer: (mount, previewRole, world) =>
    new AvatarEquipmentLayer(mount, previewRole, world, { motionPreference }),
  getRuntime: applicationState.selection,
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
const avatarSelectorRemoveAllEquipment = () =>
  avatarSelectorController.removeAllEquipment();

function disposeApplication() {
  if (applicationDisposed) return;
  applicationDisposed = true;
  window.removeEventListener("pagehide", disposeApplication);
  try {
    adapter?.stopPresenceHeartbeat?.();
  } catch {}
  try {
    adapter?.departPresence?.({ beacon: true, reason: "pagehide" });
  } catch {}
  adapter?.dispose();
  liveViewport.dispose();
  for (const remove of rootListenerRemovers.splice(0).reverse()) {
    try {
      remove();
    } catch {}
  }
  for (const controller of [
    rendererCapabilityPanel,
    applicationState,
    movementCameraController,
    avatarSelectorController,
    storefrontShoppingController,
    boardingJourneyController,
    portalRenderController,
    semanticDestinationsController,
    runtimeTweakController,
    demoTrajectoryTool,
    panelTruthChromeController,
    statusPanel,
    notificationToastController,
  ]) {
    try {
      controller?.dispose();
    } catch {}
  }
  panelTruthChromeController = null;
  storefrontShoppingController = null;
  boardingJourneyController = null;
  runtimeTweakController = null;
  demoTrajectoryTool = null;
  sceneRuntimeController?.disposePeers();
  motionPreference.dispose();
  try {
    equipmentLayer?.dispose();
  } catch {}
  equipmentLayer = null;
  try {
    sceneRuntimeController?.dispose();
  } catch {}
  scene = null;
  if (window.__assembly) {
    window.__assembly.ready = false;
    window.__assembly.disposed = true;
  }
  document.body.removeAttribute("data-assembly-ready");
}

function canonicalDebugState(raw) {
  const dbg = raw || (adapter ? adapter.debugState() : {});
  const camera = isPlayer
    ? movementCameraController.updatePlayerCamera(dbg)
    : null;
  const preview =
    isPlayer && adapter && typeof adapter.updatePreviewProjection === "function"
      ? adapter.updatePreviewProjection(camera)
      : dbg.preview;
  return projectApplicationDebug(dbg, {
    handoffPhases: HANDOFF_PHASES,
    isPlayer,
    role,
    rendererKind: scene ? scene.rendererKind : null,
    camera,
    preview,
    equipmentVisual: equipmentLayer ? equipmentLayer.debugState() : null,
    movement: movementCameraController.movementDebug(),
    portalApertureOcclusion: movementCameraController.portalOcclusionState(),
    cameraWallOcclusion: movementCameraController.cameraWallOcclusionState(),
    portalVisualAlignment,
  });
}

function updateMovementDebug(debug, movementState = null) {
  const movement = movementState ||
    movementCameraController?.updateMovementDebug(debug) || {
      previous_position: null,
      last_delta: [0, 0, 0],
      last_key_event: "none",
      keys: "none",
    };
  motionDebugPanel.render(debug, {
    movement,
    camera: movementCameraController?.playerCameraDebug() || null,
    pressedKeys: movementCameraController?.movementDebug()?.keys || "none",
  });
}

function activeSceneRole(dbg) {
  if (!isPlayer) return role;
  const active = dbg && dbg.active ? dbg.active : {};
  return active.endpoint_key === "b" ? "target" : "source";
}

function presentWowHeader() {
  appEl.className = `role-${role} wow-read rail-collapsed`;
  const roleChip = $("role-chip");
  if (roleChip) roleChip.textContent = "WoW WORLD";
  const worldAddress = (() => {
    try {
      const u = new URL(wowParam, location.href);
      return u.host + u.pathname.replace(/\/wow\/spatial\/.*$/, "");
    } catch {
      return String(wowParam);
    }
  })();
  const titleEl = $("loc-title");
  if (titleEl) titleEl.textContent = `World ${worldAddress}`;
  const metaEl = $("loc-meta");
  if (metaEl)
    metaEl.textContent = `${wowParam} · WoW composition graph · client render (buildWowScene)`;
  const modeEl = $("mode-prov");
  if (modeEl) modeEl.innerHTML = `<span class="prov">wow-graph</span>`;
  const lbEl = $("live-backend");
  if (lbEl) {
    lbEl.textContent =
      "WoW composition graph (local-data-first; live via runtime)";
    lbEl.style.color = "var(--muted, #9aa)";
  }
}

function restoreWowAvatar() {
  movementCameraController.seedOrbitCamera({ azimuth: Math.PI });
  const restorable = readRestorablePlayerSession();
  if (
    restorable &&
    typeof adapter.applyRestoredPose === "function" &&
    adapter.applyRestoredPose(restorable)
  ) {
    movementCameraController.seedOrbitCamera({
      azimuth: restorable.orbit_azimuth_rad,
      polar: restorable.orbit_polar_rad,
      distance: restorable.orbit_distance_m,
    });
    equipmentLayer.setAvatar(adapter.state.avatar);
    logLine(
      `M2 wow: session restore — resumed avatar at ${vec3Label(
        restorable.position
      )}`
    );
  }
  movementCameraController.start();
  movementCameraController.applyPlayerCamera();
}

function publishWowAvatarWalk(spawn, wk) {
  const avatarWalk = {
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
      `clamp x[${wk ? wk.min_x : "?"},${wk ? wk.max_x : "?"}] z[${
        wk ? wk.min_z : "?"
      },${wk ? wk.max_z : "?"}] ` +
      `(measured per world; reusing stepAvatar + orbit camera + VRM layer)`
  );
  return avatarWalk;
}

async function mountWowAvatar(resolved, built, loadErr) {
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
      adapter.spawnWowLocalAvatar({
        spawn,
        bounds,
        spatialID: resolved ? resolved.spatialID : null,
        title:
          (resolved && resolved.graph && resolved.graph.title) || "WoW world",
      });
      equipmentLayer = new AvatarEquipmentLayer(
        $("scene-mount"),
        role,
        adapter.world,
        {
          host: avatarLayerHost(),
          motionPreference,
        }
      );
      await equipmentLayer.ready;
      requireActiveBoot(() => applicationDisposed);
      equipmentLayer.setAvatar(adapter.state.avatar);
      listenAtRoot(adapter, "state", (ev) => {
        if (equipmentLayer && ev.detail && ev.detail.avatar)
          equipmentLayer.setAvatar(ev.detail.avatar);
      });
      restoreWowAvatar();

      avatarWalk = publishWowAvatarWalk(spawn, wk);
    } catch (e) {
      requireActiveBoot(() => applicationDisposed);
      avatarWalk = { embodied: false, error: (e && e.message) || String(e) };
      document.body.setAttribute("data-wow-avatar-embodied", "0");
      logLine(`M2 wow: avatar walk wiring ERROR: ${avatarWalk.error}`);
    }
  }
  if (!isPlayer && built && !loadErr) movementCameraController.startViewOnly();

  return avatarWalk;
}

// Iteration 5: the identity handshake with the shown world, when it states one (web/wow-handshake-mount.mjs). The
// page only selects, through its own setters, the avatar variant and the preferred height the world accepted.
function presentWowHandshake(resolved) {
  const graphHref = resolved?.graph_url ? new URL(resolved.graph_url, location.href).href : null;
  if (resolved?.source !== "canonical-walk" || !graphHref || !/^https?:/i.test(graphHref)) return;
  void presentHandshake({
    hostUrl: graphHref,
    pageUrl: location.href,
    fetch: window.fetch.bind(window),
    document,
    window,
    worldLabel: resolved.graph?.title || graphHref,
    select: (user) => {
      const applied = { variant: null, preferred_height_m: null };
      if (applicationDisposed || !adapter?.state?.avatar) return applied;
      const variant = variantForUri(user.AvatarURI, AVATAR_VARIANTS, location.href);
      if (variant && adapter.setAvatarVariant(variant).ok) applied.variant = variant;
      const height = user.osl_preferences?.preferred_height_m;
      if (height != null) {
        const r = adapter.setPreferredHeight(height);
        if (r.ok) applied.preferred_height_m = r.preferred_height_m;
      }
      equipmentLayer?.setAvatar(adapter.state.avatar);
      return applied;
    },
    // What the page draws: the avatar the layer loaded and its measured height.
    rendered: () => {
      const st = equipmentLayer?.status;
      return st
        ? {
            variant: st.avatar_variant,
            asset: st.avatar_asset_uri,
            loaded: !!(st.avatar_static_glb_loaded || st.real_vrm_loaded),
            switching: !!st.avatar_switch_in_flight,
            preferred_height_m: st.avatar_preferred_height_m,
            height_applied: st.avatar_height_applied === true,
            rendered_height_m: st.avatar_model_height_m ?? null,
          }
        : null;
    },
    logLine,
  });
}

function publishWowDriver(
  resolved,
  built,
  alternateRuntime,
  renderState,
  avatarWalk
) {
  function probeVisiblePixels() {
    return alternateRuntime
      ? sceneRuntimeController.probeVisiblePixels()
      : { ok: false, reason: "no_renderer", non_black: 0 };
  }

  const panelDebug =
    adapter && adapter.world ? adapter.debugState() : { proof_boundary: null };
  panelTruthChromeController.mount({ debug: panelDebug });
  const wowPanelChrome = panelTruthChromeController.chromeDriver();
  wowPanelChrome.close();

  const wowSurface = {
    ref: wowParam,
    resolved,
    render: {
      ...renderState,
      render_summary: built ? built.render_summary : null,
    },
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
  document.body.setAttribute(
    "data-wow-nodes",
    String(resolved ? resolved.node_count : 0)
  );
  document.body.setAttribute(
    "data-wow-rendered",
    String(built ? built.render_summary.rendered.rendered_nodes : 0)
  );
  logLine(
    `M2 wow: ready (render frames=${renderState.frames}, renderer=${
      renderState.renderer_kind || "none"
    })`
  );
}

async function mainWowRead() {
  presentWowHeader();
  adapter = new LiveAdapter(role, {
    wowRef: wowParam,
    noDefaultEquipment: noEquipParam,
    motionPreference,
  });
  logLine(`M2 wow: opening world ${wowParam}`);
  const { resolved, loadError, built, alternateRuntime, renderState } =
    await bootWow({
      adapter,
      sceneRuntime: sceneRuntimeController,
      isDisposed: () => applicationDisposed,
      logLine,
    });
  const avatarWalk = await mountWowAvatar(resolved, built, loadError);
  requireActiveBoot(() => applicationDisposed);
  presentWowHandshake(resolved);
  publishWowDriver(resolved, built, alternateRuntime, renderState, avatarWalk);
}

function handleAdapterState(event) {
  onState(event.detail);
}
const observedPhaseLog = [];
let lastObservedPhase = null;

followFooterHeight(document);
const mainDemo = createMainDemoWiring({
  THREE,
  document,
  getAdapter: () => adapter,
  getScene: () => scene,
  getSceneRuntime: () => sceneRuntimeController,
  redrawPortals: () => {
    if (scene)
      portalVisualAlignment = alignPortalVisualToTrigger(scene, adapter.world);
    onState(adapter.debugState());
  },
  logLine,
  publishNotification: publishNotificationRecord,
  showToast,
  isDeparted: (live) => live.state.phase === HANDOFF_PHASES.DEPARTED,
  isDisposed: () => applicationDisposed,
  isPlayer,
  wantsPlacement: params.get("place") === "1",
  keyOf: appPortalKey,
  getMount: () => $("scene-mount"),
  worldsUrl: withServer("/worlds.json"),
  setCameraAzimuth: (azimuth) =>
    movementCameraController.setRestoredCameraSeed({ azimuth }),
});
const crossingGuardFailures = [];

function reportCrossingGuardFailures(detail, failures) {
  const at = new Date().toISOString();
  crossingGuardFailures.push({
    at,
    handoff_id: detail.handoff_id || null,
    failures,
  });
  logLine(`crossing check failed: ${failures.join("; ")}`);
  const place = (adapter.world && adapter.world.title) || "the destination";
  const sentence = `You are in ${place}. Your place or view may be slightly off.`;
  const notificationId = `crossing-check-failed-${crossingGuardFailures.length}`;
  publishNotificationRecord({
    id: notificationId,
    kind: "crossing_check_failed",
    status: "failed",
    title: "Crossing check failed",
    summary: `${sentence} ${failures.join("; ")}`,
    created_at: at,
  });
  showToast("Crossing check failed", sentence, "failed", { notificationId });
}

async function handleAdapterCrossing(event) {
  const detail = event.detail || {};
  logLine(
    detail.kind === "reset_demotion"
      ? "world-navigator: reset — boot fabric restored as root (same context)"
      : `world-navigator: child fabric PROMOTED to root (handoff ${
          detail.handoff_id || "?"
        }); exit-intent/arrival were server-side notifications only`
  );
  const { heading, exit, failures } =
    movementCameraController.inspectCrossing(detail);
  publishExitPose(document.body, exit, logLine);
  const remapped = movementCameraController.handleCrossing(detail);
  movementCameraController.recordCrossingView(detail, remapped, heading);
  try {
    await recomposeActiveWorldScene(detail.kind || "crossing");
  } catch (error) {
    if (error?.name === "AbortError") return;
    logLine(`scene composition failed: ${error?.message || error}`);
    showToast("Scene unavailable", error?.message || String(error), "failed");
    return;
  }
  if (applicationDisposed) return;
  onState(adapter.debugState());
  if (failures.length) reportCrossingGuardFailures(detail, failures);
  movementCameraController.persistSession(true);
  void mainDemo.mountPlacementForActiveWorld();
}

function readPublicDebugState() {
  const debug = canonicalDebugState(adapterVisualDebugState());
  const previewSurface = updatePortalPreviewSurface(debug);
  if (previewSurface) {
    portalVisualAlignment = {
      ...(portalVisualAlignment || {}),
      preview_surface: previewSurface,
    };
  }
  debug.portal_visual_alignment = portalVisualAlignment || null;
  debug.portal_spatial_preview = sceneRuntimeController.portalDebug();
  worldDebugPanel.render(debug);
  publishDebugDataset(document.body, debug, role);
  return debug;
}

function createLocalAvatarLayer() {
  equipmentLayer = new AvatarEquipmentLayer(
    $("scene-mount"),
    role,
    adapter.world,
    {
      host: avatarLayerHost(),
      motionPreference,
    }
  );
  return equipmentLayer;
}
function presentLiveWorld() {
  const world = adapter.world;
  $("loc-title").textContent = world.title;
  $(
    "loc-meta"
  ).textContent = `${world.location_id} · ${world.world_id} · ${world.session_id}`;
  $(
    "mode-prov"
  ).innerHTML = `<span class="prov prov-${adapter.mode}">${adapter.mode}</span>`;
  const lb = $("live-backend");
  if (lb) {
    lb.textContent = adapter.base;
    lb.style.color = "var(--ok)";
  }

  const cb = adapter.claimBoundary();
  flagCell($("f-alh"), cb.application_level_handoff);
  flagCell($("f-ntt"), cb.native_teleportxr_teleport);
  flagCell($("f-fpr"), cb.first_party_teleportxr_browser_rendering);
  flagCell($("f-std"), cb.standards_conformance);
  const bs = adapter.boundaryStatus();
  $("f-check").textContent = bs.ok ? "PASS" : `FAIL: ${bs.problems.join("; ")}`;
  $("f-check").className = "v " + (bs.ok ? "boundary-ok" : "boundary-bad");
  if (!bs.ok) logLine(`validation-BOUNDARY FAILURE: ${bs.problems.join("; ")}`);
}
async function prepareLiveSession() {
  listenAtRoot(adapter, "portal-refused", (event) =>
    mainDemo.handlePortalRefused(event.detail)
  );
  listenAtRoot(adapter, "portal-navigate", (event) =>
    window.location.assign(event.detail.url)
  );
  adapter.listenForCrossWindow();
  listenAtRoot(window, "hashchange", () => {
    const next = readWowUrlIntent();
    if (next && adapter && typeof adapter.applyWowIntent === "function") {
      void adapter.applyWowIntent(next);
    }
  });
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
          `session restore: manual reload → resumed on ${
            restorable.active_endpoint_key
          } (${restorable.location_id || "?"}) ` +
            `at ${vec3Label(
              restorable.position
            )} (pose from sessionStorage; no world reset)`
        );
      }
    }
    if (!restorable && wowUrlIntent)
      await mainDemo.arriveAtJoin(wowUrlIntent.aspectId, wowUrlIntent.intent);
    requireActiveBoot(() => applicationDisposed);
  }

  presentLiveWorld();
}
function publishLiveRuntimeFacts() {
  logLine(
    `renderer: ${scene.rendererKind} (application renderer; not first-party TeleportXR)`
  );
  logLine(
    `portal visual alignment: ${
      portalVisualAlignment.reason || "unknown"
    } center=${vec3Label(
      portalVisualAlignment.visual_center ||
        portalVisualAlignment.trigger_center
    )}`
  );
  logLine(`LIVE backend bound: ${adapter.base}`);
  if (isPlayer) {
    sceneRuntimeController.refreshNavigator();
    const nav = adapter.debugState().navigator;
    if (nav) {
      logLine(
        `world-navigator: ${nav.status} · context=${
          nav.context_id
        } · fabrics=[${(nav.fabrics_loaded || []).join(", ")}]`
      );
      logLine(
        `fabric manifests are plain-JSON and UNSIGNED (labeled); no standards-conformance claim`
      );
    }
  }
  logLine(
    `frontend contract exposed: ${FRONTEND_CONTRACT.version_id} (${FRONTEND_CONTRACT.components})`
  );
  logLine(`role=${role} mode=${adapter.mode}`);
  logLine(`claim ceiling: ${FRONTEND_CONTRACT.claim_ceiling}`);
  if (isPlayer) {
    logLine(
      `player URL active=${adapter.activeEndpointKey} preview=${adapter.previewEndpointKey}`
    );
  }
}
function mountLivePanels() {
  panelTruthChromeController.mount({ debug: adapter.debugState() });
  wireNotificationCenter();
  wireReturnLobbyButton();
  semanticDestinationsController.mount();
  storefrontShoppingController.mount();
  boardingJourneyController.mount();

  listenAtRoot(adapter, "state", handleAdapterState);
  listenAtRoot(adapter, "crossing", handleAdapterCrossing);
  onState(adapter.debugState());
  panelTruthChromeController.mount({
    apiPanel: true,
    standards: true,
    debug: adapter.debugState(),
  });
  panelTruthChromeController.chromeDriver().close();
}
function mountLiveControls() {
  movementCameraController.start();
  const cameraToggleBtn = $("btn-camera-toggle");
  if (cameraToggleBtn && isPlayer) {
    cameraToggleBtn.hidden = false;
    cameraToggleBtn.setAttribute(
      "aria-pressed",
      String(movementCameraController.playerCameraMode() === "first_person")
    );
    listenAtRoot(cameraToggleBtn, "click", () => {
      const next = movementCameraController.togglePlayerCameraMode();
      cameraToggleBtn.setAttribute(
        "aria-pressed",
        String(next === "first_person")
      );
    });
  }
  avatarSelectorController.mount();
  portalRenderController.mount();
}
function mountPortalLoading() {
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
}
function publishLiveDriver() {
  window.__assembly = createApplicationDriver(
    {
      role,
      isPlayer,
      contract: FRONTEND_CONTRACT,
      lookup: $,
      connectionStatus: statusPanel.connectionStatus,
      getScene: () => scene,
      getEquipmentLayer: () => equipmentLayer,
      peerAvatarLayers,
      adapterVisualRuntimeSnapshot,
      debugState: readPublicDebugState,
      phaseLog: () => observedPhaseLog.map((entry) => ({ ...entry })),
      crossingGuardFailures: () =>
        crossingGuardFailures.map((entry) => ({ ...entry })),
    },
    {
      dispose: disposeApplication,
      reset: async () => {
        movementCameraController.reset();
        boardingJourneyController.reset("new_session");
        return adapter.reset();
      },
    },
    {
      adapter,
      sceneRuntimeController,
      liveViewport,
      mainDemo,
      movementCameraController,
      avatarSelectorController,
      panelTruthChromeController,
      storefrontShoppingController,
      boardingJourneyController,
      runtimeTweakController,
      semanticDestinationsController,
    }
  );
  demoTrajectoryTool = mountDemoTrajectoryTool({
    view: window,
    document,
    role,
    snapshot: () => canonicalDebugState(adapterVisualDebugState()),
  });
  if (demoTrajectoryTool) window.__assembly.demoTrajectory = demoTrajectoryTool;
  if (chooseRendererAtBoot(location.search).active.kind === "own-x3d") {
    window.__assembly.openX3dPortal = portalId => {
      const entry = X3D_PORTALS.find(value => value.portal_id === portalId && value.world === adapter.activeEndpointKey);
      if (!entry || applicationDisposed) throw new Error("X3D portal is not available in the current world");
      const selection = ownX3dDocumentSelection({ portal: entry });
      location.assign(ownX3dShellUrl(new URLSearchParams({ world: selection.filename }), withBase));
    };
  }
  liveViewport.resize({ force: true });
  window.__assembly.portalRender = portalRenderController.driver();
  window.__assembly.featurePortalLoading = featurePortalLoadingDriverApi();
  window.__assembly.notifications = {
    list: () => notificationToastController.snapshot(),
    count: () => notificationToastController.count(),
    open: (id) => openNotificationCenter(id),
    close: () => closeNotificationCenter(),
    selected: () => notificationToastController.selected(),
    isOpen: () => notificationToastController.isOpen(),
  };
}
function reportNavigatorFailure() {
  if (isPlayer) {
    const navigator = adapter.debugState().navigator;
    if (
      navigator &&
      (navigator.status === "root_fabric_unavailable" ||
        navigator.status === "child_fabric_unavailable")
    ) {
      const rootUnavailable = navigator.status === "root_fabric_unavailable";
      const failure = rootUnavailable
        ? navigator.root_fabric
        : navigator.child_fabric;
      setConnectionPresentation(
        "unavailable",
        `${
          failure && failure.error ? failure.error : navigator.status
        }. The current live world remains active.`,
        {
          kind: rootUnavailable
            ? "navigator_root_unavailable"
            : "navigator_child_unavailable",
          source_state: navigator.status,
          current: "live-world-projection",
          recovery: {
            kind: "return",
            label: "Continue in current world",
            aria_label: "Continue in the current live world",
            note: "Keeps the current live world; the unavailable fabric is not presented as loaded.",
            success_detail:
              "The current live world remains active; the unavailable fabric was not presented as loaded.",
            current: "live-world-projection",
          },
        }
      );
    }
  }
}
async function main() {
  if (documentViewerMode) return mainX3dDocument();
  if (wowParam) return mainWowRead();
  appEl.className = `role-${role} rail-collapsed`;
  $("role-chip").textContent = ROLE_DISPLAY_LABEL[role] || role.toUpperCase();
  const initialRailToggle = $("btn-rail-toggle");
  if (initialRailToggle)
    initialRailToggle.setAttribute("aria-expanded", "false");
  adapter = new LiveAdapter(role, {
    active: resolveBootActive(),
    wowIntent: wowUrlIntent,
    noDefaultEquipment: noEquipParam,
    motionPreference,
    portalAtomicityOracle: portalAtomicityOracleParam,
    crossingProfile: params.get("crossing"),
  });
  await bootLive({
    adapter,
    sceneRuntime: sceneRuntimeController,
    isDisposed: () => applicationDisposed,
    prepareSession: prepareLiveSession,
    createAvatar: createLocalAvatarLayer,
    sceneRole: activeSceneRole,
    isPlayer,
  });
  publishLiveRuntimeFacts();
  mountLivePanels();
  mountLiveControls();
  mountPortalLoading();
  publishLiveDriver();
  if (isPlayer) mainDemo.startPortalWatch();
  if (isPlayer && launcherMissionParam === "denver-skyport") {
    document.body.setAttribute(
      "data-denver-skyport-mission",
      "portal-c-server-backed"
    );
  }
  document.body.setAttribute("data-assembly-ready", "1");
  publishDebugDataset(document.body, window.__assembly.debugState(), role);
  void mainDemo.mountPlacementForActiveWorld();
  reportNavigatorFailure();
}

async function mainX3dDocument() {
  if (chooseRendererAtBoot(location.search).active.kind !== "own-x3d") throw new Error("Document viewer requires renderer=own-x3d");
  const selection = ownX3dDocumentSelection({ explicitRoute: true, world: params.get("x3dDocument") });
  appEl.className = "role-player rail-collapsed";
  $("role-chip").textContent = "DOCUMENT VIEWER";
  $("loc-title").textContent = selection.filename;
  $("loc-meta").textContent = "Local X3D document · 2.4 m/s viewer · no server world or collision claim";
  $("live-backend").textContent = "Local document; no world server session";
  const next = await sceneRuntimeController.mountX3dDocument(selection);
  requireActiveBoot(() => applicationDisposed);
  const debugState = () => ({ kind: "own-x3d-document", file: selection.filename, source_sha256: selection.sha256,
    entry: next.entry, camera: next._impl.camera.position.toArray(), actions: movementCameraController.documentActions(),
    renderer: sceneRuntimeController.activeAdapter()?.getCapabilities(), movement: movementCameraController.debug(),
    lighting: ownX3dLightingStatus(x3dEnvironment.selection, next.lighting),
    portal: next.x3dPortal ? { ...next.x3dPortal.debug(), surface: sceneRuntimeController.portalDebug(),
      preview: sceneRuntimeController.portalPreviewStates(), runtime: sceneRuntimeController.debug() }
      : { entry: null, reason: next.x3dPortalReason } });
  window.__x3dWorld = { kind: "own-x3d", worldFile: selection.filename, loaded: true, debugState };
  window.__assembly = { role: "document-viewer", ready: true, scene: next, debugState,
    dispose: disposeApplication, viewport: { snapshot: liveViewport.snapshot, forceSync: () => liveViewport.resize({ force: true }) } };
  movementCameraController.start();
  liveViewport.resize({ force: true });
  rendererCapabilityPanel?.refresh();
  document.body.dataset.x3dWorldReady = "1";
  document.body.setAttribute("data-assembly-ready", "1");
  setConnectionPresentation("live", "Local X3D document ready; no server session.");
}
function updateFabricPrefetchCard(debug) {
  const notifications = prefetchDebugPanel.render(debug, {
    isPlayer,
    assembly: !!window.__assembly,
    portalDebug: sceneRuntimeController.portalDebug(),
  });
  if (!notifications) return;
  publishFabricCompletionNotification(notifications.completion);
  for (const machine of notifications.machines)
    publishFabricPrefetchNotifications(machine);
}

function observeApplicationPhase(dbg) {
  const phase = dbg.phase;
  if (phase !== lastObservedPhase) {
    observedPhaseLog.push({ phase, at_ms: Date.now() });
    if (observedPhaseLog.length > 64) observedPhaseLog.shift();
    lastObservedPhase = phase;
  }
}
function updateSceneState(dbg) {
  const phase = dbg.phase;
  scene.setPhase(phase);
  scene.setAvatar(null);
  if (equipmentLayer) equipmentLayer.setAvatar(isPlayer ? dbg.avatar : null);
  sceneRuntimeController.syncPeers(dbg);
  sceneRuntimeController.syncPortalPeers(dbg.peer_players);
  if (
    !isPlayer &&
    dbg.live_player_pose &&
    dbg.live_player_pose.applied_count === 1
  ) {
    logLine(
      `live player pose mirror active: tracking ${
        dbg.live_player_pose.from_client_id || "player"
      } ` +
        `in ${dbg.live_player_pose.location_id} (render-only; no backend mutation)`
    );
  }
}
function updateWorldPresentation(dbg, canonical) {
  semanticDestinationsController.update({
    world: adapterVisualRuntimeSnapshot()?.world || null,
    debug: canonical,
    connectionState: statusPanel.connectionStatus().state,
    isPlayer,
  });
  worldDebugPanel.render(canonical);
  publishDebugDataset(document.body, canonical, role);
  syncReturnLobbyButton(canonical);
  storefrontShoppingController.observe({
    locationId: canonical.location_id || dbg.location_id,
    avatarPosition: dbg.avatar?.position || null,
    airportTerminal:
      sceneRuntimeController.liveAuthoredScene()?.airport_terminal || null,
  });
  boardingJourneyController.observe({
    locationId: canonical.location_id || dbg.location_id,
    avatarPosition: dbg.avatar?.position || null,
    airportTerminal:
      sceneRuntimeController.liveAuthoredScene()?.airport_terminal || null,
  });
}
function updateCrossingPresentation(phase, canonical) {
  movementCameraController.observeState(phase);
  const previewSurface = updatePortalPreviewSurface(canonical);
  if (previewSurface) {
    portalVisualAlignment = {
      ...(portalVisualAlignment || {}),
      preview_surface: previewSurface,
    };
    canonical.portal_visual_alignment = portalVisualAlignment;
  }
  if (isPlayer) {
    if (phase === HANDOFF_PHASES.DEPARTED) {
      const crossingKey = canonical.fabric_prefetch
        ? canonical.fabric_prefetch.portal_key
        : null;
      if (crossingKey) sceneRuntimeController.engagePortalTakeover(crossingKey);
    } else if (sceneRuntimeController.portalTakeoverEngaged()) {
      sceneRuntimeController.disengagePortalTakeover();
    }
  }
}
function updateStatusPresentation(dbg, canonical) {
  statusPanel.renderState(canonical);
  updateFabricPrefetchCard(canonical);
  ensureFabricPrefetchZoneRing(canonical);

  const av = dbg.avatar;
  $("a-id").textContent = av ? av.avatar_id : "—";
  $("a-cont").textContent = av ? av.continuity_id : "—";
  $("a-name").textContent = av ? av.display_name : "—";
  $("a-src").textContent =
    av && av.source_location_id
      ? av.source_location_id
      : role !== "target"
      ? dbg.location_id
      : "—";
  $("h-id").textContent = dbg.handoff_id || "—";
  $("h-count").textContent = dbg.session.arrival_count;
  renderEquipment(dbg.equipment_status, av);
  avatarSelectorController.updateInventorySelection(dbg); // legacy compatibility projection
  updateMovementDebug(canonical);
  worldDebugPanel.renderGeoPose(canonical); // GeoPose-shaped positioning card
  panelTruthChromeController.refresh(canonical); // standards, truth, and chrome are controller-owned.
  applyStageScenePresentation(scene && scene._impl ? scene._impl.scene : null);
  featureNotePortalLoadingState(canonical);
}
function onState(dbg) {
  if (applicationDisposed) return;
  observeApplicationPhase(dbg);
  updateSceneState(dbg);
  const canonical = canonicalDebugState(dbg);
  updateWorldPresentation(dbg, canonical);
  updateCrossingPresentation(dbg.phase, canonical);
  updateStatusPresentation(dbg, canonical);
}

window.addEventListener("pagehide", disposeApplication, { once: true });
liveViewport.mount();
setConnectionPresentation("loading", "Connecting to the live world…");
main()
  .then(() => {
    if (applicationDisposed) return;
    if (statusPanel.connectionStatus().state === "loading") {
      setConnectionPresentation("live", "The live world contract is healthy.");
    }
  })
  .catch((err) => {
    if (applicationDisposed || err?.name === "AbortError") return;
    const message = err && err.message ? err.message : String(err);
    const disconnected =
      (err && err.name === "TypeError" && /fetch/i.test(message)) ||
      /-> 50[234]$/.test(message) ||
      navigator.onLine === false;
    const failedBootState = disconnected ? "disconnected" : "error";
    setConnectionPresentation(
      failedBootState === "error" ? "unavailable" : failedBootState,
      disconnected
        ? "No connection. The local world services are not responding. Start them, then reload and retry this view."
        : `The live world could not finish loading: ${message}`,
      {
        kind: disconnected
          ? "boot_transport_disconnected"
          : "boot_runtime_unavailable",
        source_state: disconnected ? "fetch_failed" : "boot_failed",
      }
    );
    logLine(`FATAL: ${message}`);
    console.info(`[connection] handled live-world boot failure: ${message}`);
  });
