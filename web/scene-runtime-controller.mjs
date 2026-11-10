import { createSceneContentBuilder, createSceneAssetLoader, createHandoffAssetPacer } from "./scene-content.mjs";
import { createSceneMetadata } from "./scene-metadata.mjs";
import {createWowScenePresentation} from "./three-wow-presentation.mjs";
import {createPeerAvatarPresentation} from "./peer-avatar-presentation.mjs";
import { SpatialPortalPreviewManager } from "./portal-spatial-preview.mjs?v=meeting-critical-destination";
import { composeBoundedPreview } from "./main-demo-preview.mjs";
import { accessGhostThree } from "./hosted-access-label.mjs";
import { ringColorsOf } from "./worlds-list.mjs";
import { clampPixelRatio, renderQualityLevers } from "./render-quality-levers.mjs";
import { prepareOwnX3dScene } from "./own-x3d-document.mjs";

/**
 * Owns the selected browser scene, its renderer lifecycle, portal-preview
 * binding, and the fixture-backed client-scene renderer. Domain state remains
 * in the injected runtime facade; movement and camera policy remain in their controller.
 */
export function createSceneRuntimeController({
  THREE,
  createRenderAdapter,
  requireExplicitAvatarResources = false,
  fetchX3dDocument,
  loadX3dAmmo,
  createX3dPhysics,
  readX3dViewer,
  readX3dPermission,
  onX3dIntent,
  readX3dLighting = () => null,
  x3dWorlds = [],
  resolveX3dPortalDestination = null,
  applicationState,
  SceneClass,
  PortalPreviewManagerClass = SpatialPortalPreviewManager,
  AvatarLayerClass = null,
  buildWowScene,
  mountAirportTerminalContent,
  mountWowSceneAssets,
  mountCanonicalWorldContent,
  loadGltf,
  cloneScene,
  isPlayer,
  role,
  stageMode,
  sharedAvatarCompositing,
  motionPreference = null,
  getMount,
  documentTarget,
  windowTarget,
  locationHref,
  requestFrame,
  cancelFrame,
  getRuntime,
  getAvatarLayers,
  syncPeerAvatars: observePeerSync,
  avatarVariants = {},
  sceneRoleForDebug,
  alignPortalVisual,
  portalKey,
  setupNavigatorRender,
  onSceneChanged,
  onPortalAlignment,
  seedOrbitCamera,
  applyPlayerCamera,
  logLine,
  showToast,
  vec3Label,
}) {
  let currentScene = null;
  let wowPresentation = null;
  let previewManager = null;
  let clientSceneLoadSurface = null;
  let activeClientSceneGraph = null;
  let liveAuthoredSceneSurface = null;
  let disposed = false;
  let lastViewport = null;
  let viewportApplyCount = 0;
  let sceneIdentity = 0;
  let detachedLegacyResizeOwners = 0;
  let evaluatedPoses = [];
  const skinBindings = new Map();
  const explicitAvatarResources = requireExplicitAvatarResources || new URL(locationHref || "http://localhost/").searchParams.get("avatarRender") === "explicit";
  const destinationAssetCache = new Map();
  const metadata = createSceneMetadata(documentTarget);
  const buildContent = createSceneContentBuilder({ THREE, buildWowScene, mountAirportTerminalContent,
    sceneDescription: applicationState.sceneDescription, getMount, document: documentTarget, motionPreference });
  const loadSceneAssets = createSceneAssetLoader({ THREE, mountWowSceneAssets, loadGltf, cloneScene, cache: destinationAssetCache });

  const runtime = () => (typeof getRuntime === "function" ? getRuntime() : null);
  const peerPresentation=createPeerAvatarPresentation({
    createLayer:()=>new AvatarLayerClass(mount(),role,runtime()?.world,{host:sceneHost(),motionPreference}),
    getLocalAvatar:()=>runtime()?.state?.avatar,isPlayer,variants:avatarVariants,logLine,
  });
  function syncPeerAvatars(debug) { peerPresentation.sync(debug); observePeerSync?.(debug); }

  const mount = () => (typeof getMount === "function" ? getMount() : null);
  const avatarLayers = () => {
    const layers = typeof getAvatarLayers === "function" ? getAvatarLayers() : null;
    return {
      local: layers && layers.local ? layers.local : null,
      peers: layers && layers.peers ? Array.from(layers.peers) : [],
    };
  };

  function publishScene(next) {
    currentScene = next || null;
    const renderAdapter = currentScene?._impl?.renderAdapter;
    if (renderAdapter?.renderer?.domElement) {
      mount().appendChild(renderAdapter.renderer.domElement);
      renderAdapter.attach(mount());
    }
    if (currentScene) sceneIdentity += 1;
    if (typeof onSceneChanged === "function") onSceneChanged(currentScene);
  }

  function prepareRenderer({ allowCanvas = false } = {}) {
    const host = mount();
    const container = documentTarget.createElement("div");
    const renderAdapter = createRenderAdapter();
    const width = host?.clientWidth || 1100, height = host?.clientHeight || 660;
    try {
      renderAdapter.mount(container, { antialias: true, preserveDrawingBuffer: true, alpha: true,
        frameLoop: false, pixelRatio: 1, width, height });
    } catch (error) {
      renderAdapter.dispose();
      if (allowCanvas) return { handle: null, ready: async () => {}, dispose() {} };
      throw error;
    }
    return { handle: renderAdapter, ready: () => renderAdapter.ready(), dispose() {
      const renderer = renderAdapter.renderer;
      renderAdapter.dispose();
      retireRendererContext(renderer);
    } };
  }

  function composeRenderer(construct, options) {
    if (disposed) return Promise.reject(Object.assign(new Error("scene runtime disposed"), { name: "AbortError" }));
    return applicationState.composeScene({ prepare: () => prepareRenderer(options), construct });
  }

  function mountX3dDocument(selection) {
    if (disposed) return Promise.reject(new DOMException("scene runtime disposed", "AbortError"));
    const previous = currentScene;
    let next = null;
    return applicationState.composeScene({
      prepare: () => prepareOwnX3dScene({
        rendererPreparation: prepareRenderer(), selection,
        fetchDocument: fetchX3dDocument, loadAmmo: loadX3dAmmo, createPhysics: createX3dPhysics,
        readViewer: readX3dViewer, readPermission: readX3dPermission, dispatchIntent: onX3dIntent,
        lighting: readX3dLighting(), worlds: x3dWorlds,
        isCurrent: () => !disposed && (currentScene === previous || currentScene === next),
      }),
      construct: (prepared, assertCurrent) => {
        assertCurrent();
        const { realization, camera } = prepared.state, renderAdapter = prepared.adapter;
        next = { _impl: { scene: realization.scene, camera, renderer: renderAdapter.renderer, renderAdapter },
          world: null, rendererKind: "webgl", document: prepared.state.document,
          entry: prepared.state.runtime.viewpoints[0], lighting: prepared.lighting,
          x3dPortal: prepared.portal || null, x3dPortalReason: prepared.portalReason ?? null,
          setPhase() {}, setAvatar() {}, resize() {},
          evaluateFrame: prepared.evaluateFrame, renderFrame: prepared.renderFrame,
          activateAnchor: prepared.activate, dispose: prepared.dispose };
        disposeCurrent("scene dispose during X3D document adoption failed");
        assertCurrent();
        publishScene(next);
        resize();
        if (next.x3dPortal) {
          // The authored disc is one standard portal: the window binds to the X3D renderer, camera and scene.
          const manager = ensurePreviewManager();
          manager?.bindScene(renderAdapter.renderer, camera, realization.scene, renderAdapter);
          manager?.pruneToPortalKeys([next.x3dPortal.key]);
        } else previewManager?.bindScene(null, null, null);
        releaseRetiredContexts();
        return next;
      },
    });
  }

  async function mountWowGraph(resolved,loadError=null) {
    if(disposed)throw Object.assign(new Error("scene runtime disposed"),{name:"AbortError"});
    wowPresentation?.dispose();
    const presentation=createWowScenePresentation({THREE,resolved,loadError,mount:mount(),document:documentTarget,view:windowTarget,motionPreference,
      buildWowScene,mountAirportTerminalContent,mountWowSceneAssets,loadGltf,cloneScene,cache:destinationAssetCache,
      sceneDescription:graph=>applicationState.sceneDescription({graph}),composeRenderer,mountRenderer:mountAlternateRenderer,
      publishTerminal:publishTerminalReadyWorld,hideStageDebugVisuals,visitorPosition:()=>isPlayer && runtime()?.state?.avatar?.transform?.position,logLine});
    wowPresentation=presentation;
    return presentation.start();
  }

  function detachLegacyResizeOwner(sceneInstance) {
    const impl = sceneInstance && sceneInstance._impl;
    if (!impl || !impl._onResize || impl.__oslViewportResizeDetached) return false;
    windowTarget.removeEventListener("resize", impl._onResize);
    impl.__oslViewportResizeDetached = true;
    detachedLegacyResizeOwners += 1;
    return true;
  }

  function resize(viewport = lastViewport) {
    const explicitViewport = arguments.length > 0;
    const host = mount();
    const width = Math.max(1, Math.round(Number(viewport && viewport.width) || (host && host.clientWidth) || 1));
    const height = Math.max(1, Math.round(Number(viewport && viewport.height) || (host && host.clientHeight) || 1));
    // Apply the shared boot DPR ceiling on every resize and scene replacement.
    const pixelRatioCap = renderQualityLevers(windowTarget).pixel_ratio_cap;
    const pixelRatio = clampPixelRatio(
      Number(viewport && viewport.pixelRatio) || Number(windowTarget.devicePixelRatio) || 1,
      pixelRatioCap,
    );
    lastViewport = { width, height, pixelRatio };
    const impl = currentScene && currentScene._impl;
    if (!impl) return viewportDebug();

    const directWebGlResize =
      impl.renderer &&
      typeof impl.renderer.setPixelRatio === "function" &&
      typeof impl.renderer.setSize === "function" &&
      impl.camera &&
      typeof impl.camera.updateProjectionMatrix === "function";
    if (directWebGlResize) {
      const renderer = impl.renderer;
      if (impl.renderAdapter) impl.renderAdapter.resize({ width, height, pixelRatio });
      else {
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(width, height, false);
      }
      if (renderer.domElement) {
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
      }
      impl.camera.aspect = width / height;
      impl.camera.updateProjectionMatrix();
      if (impl.composer && typeof impl.composer.setSize === "function") impl.composer.setSize(width, height);
    } else if (impl.renderer && impl.camera && typeof currentScene.resize === "function") {
      // Compatibility for legacy scene adapters without direct renderer sizing APIs.
      currentScene.resize();
    } else if (impl.canvas) {
      impl.canvas.width = Math.round(width * pixelRatio);
      impl.canvas.height = Math.round(height * pixelRatio);
      impl.canvas.style.width = "100%";
      impl.canvas.style.height = "100%";
      impl._dpr = pixelRatio;
      impl._w = width;
      impl._h = height;
    }

    viewportApplyCount += 1;
    if (explicitViewport && previewManager) previewManager.renderActive();
    return viewportDebug();
  }

  function viewportDebug() {
    const impl = currentScene && currentScene._impl;
    const renderer = impl && impl.renderer;
    const canvas = renderer && renderer.domElement ? renderer.domElement : impl && impl.canvas;
    const camera = impl && impl.camera;
    const canvasBounds = canvas && typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : null;
    return {
      ...(lastViewport || {}),
      scene_identity: currentScene ? `scene-${sceneIdentity}` : null,
      renderer_identity: renderer ? `scene-${sceneIdentity}-renderer` : null,
      canvas_identity: canvas ? `scene-${sceneIdentity}-canvas` : null,
      animation_loop_owner_count: currentScene ? 1 : 0,
      viewport_apply_count: viewportApplyCount,
      detached_legacy_resize_owners: detachedLegacyResizeOwners,
      canvas_css_width: canvasBounds ? canvasBounds.width : null,
      canvas_css_height: canvasBounds ? canvasBounds.height : null,
      drawing_buffer_width: canvas ? canvas.width : null,
      drawing_buffer_height: canvas ? canvas.height : null,
      camera_aspect: camera ? camera.aspect : null,
      projection_matrix: camera && camera.projectionMatrix && camera.projectionMatrix.elements
        ? Array.from(camera.projectionMatrix.elements, (value) => Number(value.toFixed(8)))
        : null,
    };
  }

  function disposeScene(sceneToDispose, warning) {
    if (!sceneToDispose || typeof sceneToDispose.dispose !== "function") return;
    const renderer = sceneToDispose._impl?.renderer;
    for (const [model, binding] of skinBindings) if (binding.adapter === sceneToDispose._impl?.renderAdapter) releaseSkinBinding(model, binding);
    try {
      sceneToDispose.dispose();
    } catch (error) {
      console.warn(warning, error);
    }
    retireRendererContext(renderer);
  }

  function disposeCurrent(warning = "scene dispose failed") {
    const previous = currentScene;
    if(previous && wowPresentation?.runtime()===previous){wowPresentation.dispose();wowPresentation=null;}
    publishScene(null);
    disposeScene(previous, warning);
  }

  // Dispose renderer resources before losing its context; preview/current references
  // must release that renderer before context loss can safely run.
  const pendingContextRelease = new Set();
  let releasedContextCount = 0;

  function rendererStillReferenced(renderer) {
    const impl = currentScene && currentScene._impl;
    if (impl && impl.renderer === renderer) return true;
    if (previewManager) {
      // Unknown preview contracts retain the context rather than invalidate a live surface.
      if (!("renderer" in previewManager)) return true;
      if (previewManager.renderer === renderer) return true;
    }
    return false;
  }

  function releaseRetiredContexts() {
    if (!pendingContextRelease.size) return releasedContextCount;
    for (const renderer of Array.from(pendingContextRelease)) {
      if (rendererStillReferenced(renderer)) continue;
      pendingContextRelease.delete(renderer);
      try {
        if (typeof renderer.forceContextLoss === "function") {
          renderer.forceContextLoss();
          releasedContextCount += 1;
        }
      } catch (error) {
        console.warn("retired renderer context release failed", error);
      }
    }
    return releasedContextCount;
  }

  function retireRendererContext(renderer) {
    if (!renderer) return;
    pendingContextRelease.add(renderer);
    releaseRetiredContexts();
  }

  function sceneHost() {
    if (!sharedAvatarCompositing || !currentScene || currentScene.rendererKind !== "webgl") return null;
    const impl = currentScene._impl;
    if (!impl || !impl.scene || !impl.camera || !impl.renderer) return null;
    return { scene: impl.scene, camera: impl.camera, renderer: impl.renderer, externalFrame: true };
  }

  function rehostAvatarLayers({ avatar = undefined } = {}) {
    const host = sceneHost();
    const layers = avatarLayers();
    if (layers.local && typeof layers.local.setHost === "function") layers.local.setHost(host);
    if (layers.local && avatar !== undefined && typeof layers.local.setAvatar === "function") {
      layers.local.setAvatar(avatar);
    }
    for (const layer of layers.peers) {
      if (layer && typeof layer.setHost === "function") layer.setHost(host);
    }
    return host;
  }

  function ensurePreviewManager() {
    if (!isPlayer || previewManager) return previewManager;
    previewManager = new PortalPreviewManagerClass({
      AvatarLayerClass,
      getMount: mount,
      motionPreference,
      resolveDestinationContent: (entry) => {
        const capabilities = runtime();
        if (!capabilities || typeof capabilities.resolvePortalDestinationContent !== "function") {
          // The X3D document route has no LiveAdapter: its one authored portal reads the same bounded preview.
          if (entry?.x3d_document_portal && typeof resolveX3dPortalDestination === "function") return resolveX3dPortalDestination(entry);
          throw new Error("canonical portal destination resolver is unavailable");
        }
        return capabilities.resolvePortalDestinationContent(entry);
      },
      // A portal's window looks only into what its destination declared.
      composeDestinationContent: (content, context) => {
        if (content?.kind !== "wow_bounded_preview") throw new Error("a portal shows only its destination's bounded preview");
        return composeBoundedPreview(content, context, {
          THREE,
          buildWowScene,
          mountAirportTerminalContent,
          mountWowSceneAssets,
          loadGltf,
          cloneScene,
          cache: destinationAssetCache,
          document: documentTarget,
          motionPreference,
          accessGhost: accessGhostThree,
        });
      },
      ringColorOf: (locationId) => ringColorsOf(locationId).color,
      visitorPosition: () => {
        const capabilities = runtime();
        const avatar = capabilities && capabilities.state ? capabilities.state.avatar : null;
        return avatar && Array.isArray(avatar.position) ? avatar.position : null;
      },
      controlledPlayerId: () => {
        const capabilities = runtime();
        return capabilities && typeof capabilities.controlledPlayerId === "function"
          ? capabilities.controlledPlayerId()
          : null;
      },
    });
    return previewManager;
  }

  function bindPreviewToCurrent(validPortalKeys = null) {
    const manager = ensurePreviewManager();
    if (!manager) return;
    const impl = currentScene && currentScene._impl;
    if (
      impl &&
      currentScene.rendererKind === "webgl" &&
      impl.renderer &&
      impl.camera &&
      impl.scene
    ) {
      manager.bindScene(impl.renderer, impl.camera, impl.scene, impl.renderAdapter);
    } else {
      manager.bindScene(null, null, null);
    }
    if (validPortalKeys) manager.pruneToPortalKeys(validPortalKeys);
    // Rebinding removes the preview's last reference to a retired renderer.
    releaseRetiredContexts();
  }

  function hideStageDebugVisuals(root, force = false) {
    if ((!stageMode && !force) || !root || typeof root.traverse !== "function") return 0;
    let hidden = 0;
    root.traverse((node) => {
      const name = String((node && node.name) || "");
      const debugVisual =
        node.type === "GridHelper" ||
        name.startsWith("wow-group-gizmo:") ||
        name === "fabric-root-portal-trigger-node" ||
        name.startsWith("fabric-prefetch-zone-ring") ||
        name === "demo-portal-drag-handle" ||
        name === "portal-frame-right-axis";
      if (debugVisual && node.visible !== false) {
        node.visible = false;
        hidden += 1;
      }
    });
    documentTarget.body.setAttribute("data-stage-debug-visuals-hidden", String(hidden));
    return hidden;
  }

  // The authored-scene arrival barrier is per-world attribution, never a global
  // boolean: `data-authored-scene-world` names the world whose authored scene is
  // mounted right now, so a crossing gate cannot be satisfied by the scene the
  // player is leaving. `data-airport-backend-scene` is retained as the airport's
  // own alias and is published only when the mounted world IS the airport.
  // Airport readiness is an alias of the mounted terminal world, cleared with it.
  function publishTerminalReadyWorld(spatialId) {
    if (disposed && spatialId) return;
    metadata.publishTerminalReadyWorld(spatialId);
  }

  // Backend advertisement selects authored content independently of world identity.
  function activeAuthoredGraph(world) {
    const capabilities = runtime();
    const resolved = capabilities && typeof capabilities.wowResolved === "function"
      ? capabilities.wowResolved()
      : null;
    if (!resolved || !resolved.graph || resolved.authored_graph !== true) return null;
    return resolved;
  }

  function clearLiveAuthoredPublication() {
    liveAuthoredSceneSurface = null;
    documentTarget.body.removeAttribute("data-authored-scene-world");
    documentTarget.body.removeAttribute("data-airport-backend-scene");
    publishTerminalReadyWorld(null);
    metadata.clearAssets();
    delete windowTarget.__airportBackendScene;
  }

  function mountLiveAuthoredAirport({ world, resolved, phase, reason, renderAdapter }) {
    const content = buildContent(resolved, { world, source: "live_backend_authored_wow_graph" });
    const { built, airportTerminal, renderState, width, height } = content;
    if (!airportTerminal?.walkable_surface?.entry_ground?.ok) {
      throw new Error("live airport authored graph has no rendered entry ground");
    }
    hideStageDebugVisuals(built.scene);
    let alignment = null;
    const next = mountAlternateRenderer({
      built,
      renderState,
      width,
      height,
      world,
      renderAdapter,
      beforeFirstRender: (sceneInstance) => {
        const capabilities = runtime();
        rehostAvatarLayers({ avatar: capabilities ? capabilities.avatar() : null });
        if (capabilities && typeof syncPeerAvatars === "function") {
          syncPeerAvatars(capabilities.debugState());
        }
        alignment = typeof alignPortalVisual === "function"
          ? alignPortalVisual(sceneInstance, world)
          : null;
        if (typeof onPortalAlignment === "function") onPortalAlignment(alignment);
        const entries = Array.isArray(world.portals) ? world.portals : [];
        bindPreviewToCurrent(entries.map((entry) => portalKey(entry)));
        if (typeof applyPlayerCamera === "function") applyPlayerCamera();
      },
    });
    next.setPhase(phase);
    clearClientScenePublication();
    const isCurrent = () => !disposed && currentScene === next;
    const assetState = loadSceneAssets(built, {
      isCurrent, baseUrl: resolved.graph_url || resolved.base_url || locationHref,
      beforeMount: createHandoffAssetPacer(isCurrent, () => runtime()?.isHandoffInFlight?.() === true, requestFrame),
      onSettled: metadata.publishAssetCounts,
      onError: error => logLine(`live airport asset ingest failed: ${error}`),
    });
    liveAuthoredSceneSurface = {
      source: "live_backend_authored_wow_graph",
      location_id: world.location_id,
      world_id: world.world_id,
      graph_url: resolved.graph_url,
      spatial_id: resolved.spatialID,
      node_count: resolved.node_count,
      renderer_kind: renderState.renderer_kind,
      one_selected_renderer: true,
      airport_terminal: airportTerminal,
      assets: assetState,
      reason: reason || "live_mount",
    };
    documentTarget.body.removeAttribute("data-client-scene-load");
    metadata.publishAuthoredSceneWorld(world, resolved);
    publishTerminalReadyWorld(resolved?.spatialID || world?.world_id);
    metadata.resetAssets(built.asset_nodes || []);
    windowTarget.__airportBackendScene = liveAuthoredSceneSurface;
    metadata.publishWorldHeader(world, `${runtime()?.base || ""} · authored /wow/graph`);
    logLine(
      `live airport authored scene mounted (${reason || "live_mount"}): ` +
        `${airportTerminal.storefront_count} storefronts, ${airportTerminal.npc_count} travelers, ` +
        `one selected renderer`,
    );
    return next;
  }

  function mountLive(options) {
    return composeRenderer(renderAdapter => mountReadyLive({ ...options, renderAdapter }), { allowCanvas: !activeAuthoredGraph(options.world) });
  }

  function mountReadyLive({ world, sceneRole, phase, reason = "live_mount", renderAdapter }) {
    if (disposed) throw new Error("scene runtime disposed");
    const authoredGraph = activeAuthoredGraph(world);
    if (authoredGraph) {
      return mountLiveAuthoredAirport({
        world,
        resolved: authoredGraph,
        phase,
        reason,
        renderAdapter,
      });
    }
    clearLiveAuthoredPublication();
    disposeCurrent("scene dispose during live mount failed");
    const next = new SceneClass(mount(), sceneRole, world, { frameLoop: false, renderAdapter, canvasOnly: !renderAdapter, sceneDescription: applicationState.sceneDescription({ world, graph: null }) });
    next.setAvatar(null);
    next.setPhase(phase);
    publishScene(next);
    detachLegacyResizeOwner(next);
    if (lastViewport) resize();
    const alignment = typeof alignPortalVisual === "function" ? alignPortalVisual(next, world) : null;
    if (typeof onPortalAlignment === "function") onPortalAlignment(alignment);
    bindPreviewToCurrent();
    return next;
  }

  function clearClientScenePublication() {
    clientSceneLoadSurface = null;
    activeClientSceneGraph = null;
    documentTarget.body.removeAttribute("data-client-scene-load");
    publishTerminalReadyWorld(null);
    metadata.clearAssets();
    delete windowTarget.__airportLobbySceneLoad;
    if (windowTarget.__assembly) windowTarget.__assembly.clientSceneLoad = () => null;
  }

  function recomposeClientScene({ capabilities, world, reason, renderAdapter }) {
    const content = buildContent(activeClientSceneGraph, { world });
    const { built, airportTerminal } = content;
    if (!airportTerminal) throw new Error("airport scene recomposition lost terminal content");
    hideStageDebugVisuals(built.scene);
    const next = mountAlternateRenderer({ ...content, renderAdapter });
    rehostAvatarLayers({ avatar: capabilities.avatar() });
    if (typeof syncPeerAvatars === "function") syncPeerAvatars(capabilities.debugState());
    const entries = Array.isArray(world.portals) ? world.portals : [];
    const alignment = typeof alignPortalVisual === "function" ? alignPortalVisual(next, world) : null;
    if (typeof onPortalAlignment === "function") onPortalAlignment(alignment);
    bindPreviewToCurrent(entries.map(entry => portalKey(entry)));
    clientSceneLoadSurface.airport_terminal = airportTerminal;
    clientSceneLoadSurface.recomposition = {
      reason: reason || "client_scene_recomposition", scene_identity: sceneIdentity,
      ground_contract_source: airportTerminal.walkable_surface.source,
    };
    loadSceneAssets(built, {
      isCurrent: () => !disposed && currentScene === next,
      baseUrl: activeClientSceneGraph.base_url || activeClientSceneGraph.graph_url || locationHref,
      onError: error => logLine(`airport recomposition asset ingest failed: ${error}`),
    });
    if (typeof applyPlayerCamera === "function") applyPlayerCamera();
    logLine(`airport scene recomposed (${reason || "client_scene_recomposition"}); grounding contract rebound from local world data`);
    return next;
  }

  async function recomposeLive(reason) {
    const capabilities = runtime();
    if (!isPlayer || !capabilities || !capabilities.world) return null;
    const world = capabilities.world;
    if (clientSceneLoadSurface && activeClientSceneGraph && world.location_id === clientSceneLoadSurface.target.spatial_id) {
      return composeRenderer(renderAdapter => recomposeClientScene({ capabilities, world, reason, renderAdapter }));
    }
    const next = await mountLive({
      world,
      sceneRole: sceneRoleForDebug(capabilities.debugState()),
      phase: capabilities.phase(),
      reason: reason || "crossing",
    });
    rehostAvatarLayers({ avatar: capabilities.avatar() });
    if (typeof applyPlayerCamera === "function") applyPlayerCamera();
    if (typeof setupNavigatorRender === "function") setupNavigatorRender();
    const implementation = next && next._impl;
    if (implementation?.renderer?.render && implementation.scene && implementation.camera) {
      implementation.renderAdapter?.requestRender();
    }
    metadata.publishWorldHeader(world, capabilities.base);
    if (reason === "return_to_lobby" || reason === "client_scene_load_failed") clearClientScenePublication();
    const entries = Array.isArray(world.portals) && world.portals.length
      ? world.portals
      : world.portal
        ? [world.portal]
        : [];
    if (previewManager) previewManager.pruneToPortalKeys(entries.map((entry) => portalKey(entry)));
    logLine(
      `world-navigator: active scene recomposed → ${world.location_id} (${reason || "crossing"}); ` +
        "same context, no page reload"
    );
    return next;
  }

  function renderChildFabricPreviewPass(preview) {
    if (!isPlayer || !currentScene) return;
    const capabilities = runtime();
    const impl = currentScene._impl;
    const pass = impl && impl.childFabricRender;
    if (!pass || !pass.active || !impl.renderer || !impl.scene) return;
    const primaryKey = capabilities?.world?.portal ? portalKey(capabilities.world.portal) : null;
    if (primaryKey && previewManager?.surfaceActive?.(primaryKey)) return;
    const rel = preview && preview.source_camera_relative_to_portal
      ? preview.source_camera_relative_to_portal.local_position
      : null;
    const lx = rel && Number.isFinite(Number(rel.x)) ? Number(rel.x) : 0;
    const ly = rel && Number.isFinite(Number(rel.y)) ? Number(rel.y) : 0;
    const lateral = Math.max(-0.5, Math.min(0.5, -lx * 0.25));
    const vertical = Math.max(-0.25, Math.min(0.25, ly * 0.12));
    const anchor = pass.anchor;
    pass.camera.position.set(
      anchor.portal[0] - anchor.dir[0] * 0.55 + anchor.right[0] * lateral,
      1.6 + vertical,
      anchor.portal[2] - anchor.dir[2] * 0.55 + anchor.right[2] * lateral
    );
    pass.camera.lookAt(anchor.spawn[0], 1.15, anchor.spawn[2]);
    impl.renderAdapter.renderScene(impl.scene, pass.camera, { target: pass.renderTarget, clearColor: pass.clearColor });
    if (capabilities && typeof capabilities.markChildFabricPreviewFrame === "function") {
      capabilities.markChildFabricPreviewFrame();
    }
  }

  function mountAlternateRenderer({ built, renderState, width, height, world = null, beforeFirstRender = null, renderAdapter }) {
    if (disposed) throw new Error("scene runtime disposed");
    if (!built || !built.scene || !built.camera) throw new Error("alternate renderer requires a built scene");
    disposeCurrent("scene dispose during alternate mount failed");
    if (!renderAdapter) throw new Error("alternate scene requires an application-prepared renderer");
    renderAdapter.useScene(built.scene, built.camera);
    const renderer = renderAdapter.renderer;
    renderState.renderer_kind = "three-webgl";
    let stopped = false;
    const renderOnce = () => {
      if (stopped) return;
      try {
        renderAdapter.requestRender();
        renderState.frames += 1;
      } catch (error) {
        renderState.error = (error && error.message) || String(error);
      }
    };
    const next = {
      _impl: { scene: built.scene, camera: built.camera, renderer, renderAdapter },
      world,
      rendererKind: "webgl",
      setPhase() {},
      setAvatar() {},
      resize() {},
      evaluateFrame: (seconds) => { if (!stopped) built.airport_entity_runtime?.update(seconds, built.camera); },
      renderFrame: renderOnce,
      dispose() {
        if (stopped) return;
        stopped = true;
        try { built.airport_hud_overlay?.dispose(); } catch {}
        try { built.airport_entity_runtime?.dispose(); } catch {}
        try { renderAdapter.dispose(); } catch {}
        // The canvas is already detached here, so the context release below can
        // only ever fire against a surface that is out of the document.
      },
    };
    publishScene(next);
    resize();
    bindPreviewToCurrent();
    if (typeof beforeFirstRender === "function") beforeFirstRender(next);
    built.airport_entity_runtime?.update(0, built.camera);
    renderOnce();
    return next;
  }

  function releaseSkinBinding(model, binding) {
    binding.adapter.disposeSkin?.(binding.skin);
    for (const [mesh, mask] of binding.hiddenMeshes || []) mesh.layers.mask = mask;
    skinBindings.delete(model);
  }

  function publishEvaluatedPoses(layers) {
    const adapter = currentScene?._impl?.renderAdapter;
    evaluatedPoses = [];
    const activeModels = new Set();
    for (const layer of [layers.local, ...layers.peers].filter(Boolean)) {
      const pose = layer.evaluatedPose?.();
      if (!pose) continue;
      evaluatedPoses.push(pose);
      const model = layer._avatarModel;
      if (!adapter || !model) continue;
      activeModels.add(model);
      let binding = skinBindings.get(model);
      if (!binding || binding.adapter !== adapter) {
        if (binding) releaseSkinBinding(model, binding);
        binding = { adapter, skin: explicitAvatarResources ? adapter.bindSkin(pose.rig) : adapter.bindSkin(model, pose.rig || pose), hiddenMeshes: new Map() };
        if (explicitAvatarResources) adapter.add(adapter.sceneRoot, binding.skin.root);
        skinBindings.set(model, binding);
      }
      if (binding.skin.supported) {
        adapter.setSkinPose(binding.skin, explicitAvatarResources ? pose : pose.jointLocalMatrices);
        if (explicitAvatarResources) {
          // Keep evaluator transforms and visibility policy intact, but only the
          // independent binding contributes pixels to the shared depth buffer.
          model.traverse(mesh => { if (mesh.isMesh) { if (!binding.hiddenMeshes.has(mesh)) binding.hiddenMeshes.set(mesh, mesh.layers.mask); mesh.layers.mask = 0; } });
          adapter.setVisible(binding.skin.root, model.visible && layer.avatarRig.visible);
        }
        layer.status.avatar_resource_path = explicitAvatarResources ? "explicit" : "shared-three";
      }
    }
    for (const [model, binding] of skinBindings) if (!activeModels.has(model)) releaseSkinBinding(model, binding);
  }

  function probeVisiblePixels() {
    const renderer = currentScene && currentScene._impl ? currentScene._impl.renderer : null;
    if (!renderer) return { ok: false, reason: "no_renderer", non_black: 0 };
    const canvas = renderer.domElement;
    const width = canvas.width;
    const height = canvas.height;
    try {
      const sampleCanvas = documentTarget.createElement("canvas");
      sampleCanvas.width = width;
      sampleCanvas.height = height;
      const context = sampleCanvas.getContext("2d");
      context.drawImage(canvas, 0, 0);
      const data = context.getImageData(0, 0, width, height).data;
      let sampled = 0;
      let nonBlack = 0;
      let maxLum = 0;
      for (let index = 0; index + 2 < data.length; index += 4 * 53) {
        sampled += 1;
        const lum = data[index] + data[index + 1] + data[index + 2];
        if (lum > 24) nonBlack += 1;
        if (lum > maxLum) maxLum = lum;
      }
      return {
        ok: nonBlack > 0,
        width,
        height,
        sampled,
        non_black: nonBlack,
        fraction: Number((nonBlack / Math.max(1, sampled)).toFixed(4)),
        max_lum: maxLum,
      };
    } catch (error) {
      return { ok: false, reason: (error && error.message) || String(error), non_black: 0 };
    }
  }

  function prepareClientScene(resolved) {
    return composeRenderer(renderAdapter => {
      const content = buildContent(resolved);
      const { built, airportTerminal } = content;
      if (!airportTerminal) throw new Error("airport graph did not mount airport-terminal content");
      hideStageDebugVisuals(built.scene);
      const handle = { ...content, renderAdapter };
      return { handle, walkable: airportTerminal.walkable_surface, dispose() {
        built.airport_hud_overlay?.dispose();
        built.airport_entity_runtime?.dispose();
        const renderer = renderAdapter.renderer;
        renderAdapter.dispose();
        retireRendererContext(renderer);
      } };
    });
  }

  function commitClientScene(handle, { target, contract, resolved, entered }) {
    const { built, airportTerminal, renderAdapter, width, height } = handle;
    const renderState = { frames: 0, error: null, renderer_kind: null, width, height };
    if (typeof seedOrbitCamera === "function") {
      seedOrbitCamera({ azimuth: Math.PI, avatarPosition: contract.entry_spawn.position });
    }
    const destinationCapabilities = runtime();
    const reciprocalEntries = Array.isArray(destinationCapabilities.world?.portals)
      ? destinationCapabilities.world.portals
      : [];
    let alignment = null;
    const replacementScene = mountAlternateRenderer({
      built,
      renderAdapter,
      renderState,
      width,
      height,
      beforeFirstRender: (next) => {
        rehostAvatarLayers({ avatar: destinationCapabilities.avatar() });
        if (typeof syncPeerAvatars === "function") {
          syncPeerAvatars(destinationCapabilities.debugState());
        }
        alignment = typeof alignPortalVisual === "function"
          ? alignPortalVisual(next, destinationCapabilities.world)
          : null;
        if (typeof onPortalAlignment === "function") onPortalAlignment(alignment);
        bindPreviewToCurrent(reciprocalEntries.map((entry) => portalKey(entry)));
        if (typeof applyPlayerCamera === "function") applyPlayerCamera();
      },
    });
    return publishClientScene({ built, airportTerminal, replacementScene }, { target, contract, resolved, entered });
  }

  function publishClientScene({ built, airportTerminal, replacementScene }, { target, contract, resolved, entered }) {
    metadata.publishClientHeader(target, contract, resolved);
    documentTarget.body.setAttribute("data-client-scene-load", "airport");
    publishTerminalReadyWorld(contract?.spatial_id || resolved?.spatialID);
    metadata.resetAssets(built.asset_nodes || []);
    const assetState = loadSceneAssets(built, {
      isCurrent: () => !disposed && currentScene === replacementScene,
      baseUrl: resolved.base_url || resolved.graph_url || locationHref,
      onAsset: item => logLine(`airport asset ${item.status}: ${item.label}` +
        `${item.from_cache ? " (cache)" : ""}${item.error ? " — " + item.error : ""}`),
      onSettled: summary => {
        metadata.publishAssetCounts(summary);
        logLine(`airport assets settled: loaded=${summary.loaded} failed=${summary.failed}`);
      },
      onError: error => logLine(`airport asset ingest failed: ${error}`),
    });
    clientSceneLoadSurface = {
      target,
      contract,
      graph: {
        spatialID: resolved.spatialID,
        graph_url: resolved.graph_url,
        node_count: resolved.node_count,
      },
      airport_terminal: airportTerminal,
      walkable_extent: built.render_summary.walkable_extent,
      assets: assetState,
      entered,
    };
    activeClientSceneGraph = {
      graph: resolved.graph,
      source: resolved.source,
      base_url: resolved.base_url,
      graph_url: resolved.graph_url,
    };
    if (windowTarget.__assembly) {
      windowTarget.__assembly.clientSceneLoad = () => ({
        ...clientSceneLoadSurface,
        adapter: runtime()?.debugState().client_scene_load,
      });
    }
    windowTarget.__airportLobbySceneLoad = clientSceneLoadSurface;
    logLine(
      `airport scene ready: ${airportTerminal.storefront_count} storefronts, ` +
        `${airportTerminal.npc_count} travelers, ${airportTerminal.gate.gate}; ` +
        `spawn=${vec3Label(contract.entry_spawn.position)}`
    );
    showToast("Denver Skyport", "Airport terminal loaded in the same player session.", "arrived");
    return clientSceneLoadSurface;
  }

  function mountClientSceneLoad(target) {
    if (!isPlayer || !runtime()) return Promise.reject(new Error("client scene load requires the live player adapter"));
    const sourceScene = currentScene;
    return applicationState.loadClientScene(target, {
      isCurrent: () => !disposed && (target?.transition === "client_scene_return" || currentScene === sourceScene),
      prepare: prepareClientScene,
      commit: commitClientScene,
      rollback: () => recomposeLive("client_scene_load_failed"),
    });
  }

  function cameraSpaceOfPoint(point) {
    const impl = currentScene && currentScene._impl;
    if (!impl || !impl.camera || !Array.isArray(point) || point.length < 3) return null;
    impl.camera.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(impl.camera.matrixWorld).invert();
    const value = new THREE.Vector3(
      Number(point[0]) || 0,
      Number(point[1]) || 0,
      Number(point[2]) || 0
    ).applyMatrix4(inverse);
    return [Number(value.x.toFixed(4)), Number(value.y.toFixed(4)), Number(value.z.toFixed(4))];
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    applicationState.cancelComposition();
    peerPresentation.dispose();
    wowPresentation?.dispose();wowPresentation=null;
    if (previewManager) previewManager.dispose();
    previewManager = null;
    disposeCurrent("scene runtime dispose failed");
    // Preview disposal and scene retirement have released their renderer references.
    releaseRetiredContexts();
    clearClientScenePublication();
    clearLiveAuthoredPublication();
  }

  return Object.freeze({
    publishTerminalReadyWorld,
    syncPeers:syncPeerAvatars,
    peerLayers:()=>peerPresentation.layers,
    disposePeers:peerPresentation.dispose,
    scene: () => currentScene,
    activeAdapter: () => currentScene?._impl?.renderAdapter || null,
    publishEvaluatedPoses,
    evaluatedPoses: () => evaluatedPoses,
    rendererKind: () => currentScene ? currentScene.rendererKind : null,
    avatarHost: sceneHost,
    rehostAvatarLayers,
    hideStageDebugVisuals,
    mountLive,
    recomposeLive,
    mountAlternateRenderer,
    mountWowGraph,
    mountX3dDocument,
    activateX3dDocumentAt(event) {
      if (disposed || !currentScene?.activateAnchor) return false;
      const box = mount().getBoundingClientRect();
      if (!box.width || !box.height) return false;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1,
        -(event.clientY - box.top) / box.height * 2 + 1), currentScene._impl.camera);
      return currentScene.activateAnchor({ origin: ray.ray.origin.toArray(), direction: ray.ray.direction.toArray() });
    },
    composeRenderer,
    mountClientSceneLoad,
    renderChildFabricPreview: renderChildFabricPreviewPass,
    refreshNavigator: () => {
      if (typeof setupNavigatorRender === "function") setupNavigatorRender();
    },
    renderPortalPreviews: (deltaSeconds) => {
      if (!previewManager) return;
      const portal = currentScene?.x3dPortal;
      if (portal) portal.apply(previewManager.surfaceForPortal(portal.key, null, portal.entry));
      previewManager.renderActive(deltaSeconds);
    },
    syncPortalPeers: (peers) => {
      if (previewManager && typeof previewManager.setPeerPlayers === "function") {
        previewManager.setPeerPlayers(peers);
      }
    },
    portalSurface: (key, machine, entry) => previewManager
      ? previewManager.surfaceForPortal(key, machine, entry)
      : null,
    portalMachineRenderable: (machine) => PortalPreviewManagerClass.machineRenderable(machine),
    prunePortalKeys: (keys) => { if (previewManager) previewManager.pruneToPortalKeys(keys); },
    engagePortalTakeover: (key) => { if (previewManager) previewManager.engageTakeover(key); },
    disengagePortalTakeover: () => { if (previewManager) previewManager.disengageTakeover(); },
    portalTakeoverEngaged: () => !!(previewManager && previewManager.takeover.engaged),
    portalDebug: () => previewManager ? previewManager.debug() : null,
    portalPreviewStates: () => previewManager ? previewManager.previewStates() : {},
    forgetPortalPreview: (entry) => { if (previewManager) previewManager.forgetDestination(entry); },
    destinationAssetCache: () => destinationAssetCache,
    samplePortalApertureTexels: (key, points) => previewManager
      ? previewManager.sampleApertureTexels(key, points)
      : null,
    probeVisiblePixels,
    cameraSpaceOfPoint,
    clientSceneLoad: () => clientSceneLoadSurface,
    liveAuthoredScene: () => liveAuthoredSceneSurface,
    clientSceneLoadInFlight: applicationState.clientSceneLoadInFlight,
    resize,
    viewportDebug,
    debug: () => ({
      selected_runtime: currentScene ? currentScene.rendererKind : null,
      client_scene_load_in_flight: applicationState.clientSceneLoadInFlight(),
      client_scene_load_active: !!clientSceneLoadSurface,
      live_authored_scene_active: !!liveAuthoredSceneSurface,
      portal_preview_bound: !!previewManager,
      webgl_contexts_released: releasedContextCount,
      webgl_contexts_awaiting_release: pendingContextRelease.size,
      disposed,
    }),
    dispose,
  });
}
