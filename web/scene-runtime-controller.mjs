import { SpatialPortalPreviewManager } from "./portal-spatial-preview.mjs?v=meeting-critical-destination";
import {
  disposeHostedSceneObjectMeshes,
  syncHostedSceneObjectMeshes,
} from "./portal-render-controller.mjs";
import { clampPixelRatio, renderQualityLevers } from "./render-quality-levers.mjs";

/**
 * Owns the selected browser scene, its renderer lifecycle, portal-preview
 * binding, and the fixture-backed client-scene renderer. Domain state remains
 * in the injected runtime facade; movement and camera policy remain in app.js.
 */
export function createSceneRuntimeController({
  THREE,
  SceneClass,
  PortalPreviewManagerClass = SpatialPortalPreviewManager,
  AvatarLayerClass = null,
  buildWowScene,
  mountAirportTerminalContent,
  mountWowSceneAssets,
  mountCanonicalWorldContent,
  loadGltf,
  cloneScene,
  airportSceneContract,
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
  syncPeerAvatars,
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
  let previewManager = null;
  let clientSceneLoadInFlight = false;
  let clientSceneLoadSurface = null;
  let activeClientSceneGraph = null;
  let liveAuthoredSceneSurface = null;
  let disposed = false;
  let lastViewport = null;
  let viewportApplyCount = 0;
  let sceneIdentity = 0;
  let detachedLegacyResizeOwners = 0;
  const destinationAssetCache = new Map();

  const runtime = () => (typeof getRuntime === "function" ? getRuntime() : null);
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
    if (currentScene) sceneIdentity += 1;
    if (typeof onSceneChanged === "function") onSceneChanged(currentScene);
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
    // this is the AUTHORITATIVE clamp — it re-runs on
    // every window resize and every world crossing, so it overrides whatever a
    // renderer was constructed with. The ceiling is the shared boot lever
    // (`?dpr_cap=`), never a literal, or the other two sites drift out of sync.
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
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
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
    try {
      sceneToDispose.dispose();
    } catch (error) {
      console.warn(warning, error);
    }
  }

  function disposeCurrent(warning = "scene dispose failed") {
    const previous = currentScene;
    publishScene(null);
    disposeScene(previous, warning);
  }

  // release the GPU context of retired renderers.
  //
  // In the vendored three r160, `renderer.dispose()`
  // (runtime/scene-core/vendor/three/three.module.js:29056)
  // frees the render lists, properties and program caches and removes three's
  // own context listeners, but it never releases the WebGL context itself. The
  // only API that does is `forceContextLoss()` (:28781), which asks for
  // `WEBGL_lose_context` and calls `loseContext()`. Because every world
  // remount builds a fresh renderer in `mountAlternateRenderer`, leaving the
  // context attached leaked exactly one context per portal crossing: at
  // Chrome's 16-live cap the oldest was force-evicted mid-session, and GPU RSS
  // grew 244 -> 1858 MB over 23 crossings versus 185 -> 222 MB when the retired
  // contexts were released.
  //
  // Ordering matters and is deliberate: `dispose()` runs first so that three's
  // own `webglcontextlost` handler is already unregistered when the loss event
  // arrives, which keeps the retired renderer from flipping `_isContextLost` or
  // entering a restore path. `forceContextLoss()` touches only the extension,
  // never `_gl` or any of the sub-objects `dispose()` just tore down, so it is
  // safe to call afterwards.
  //
  // The release is GATED rather than unconditional. Force-losing a context that
  // something can still draw into would be far worse than the leak, and one
  // surviving reference can outlive retirement: the portal preview manager
  // caches the renderer it was bound to (`SpatialPortalPreviewManager.renderer`)
  // and only ever swaps it in `bindPreviewToCurrent`. Two paths retire a scene
  // while that cached reference is still stale — `mountAlternateRenderer`
  // retires the old scene before the replacement renderer exists and rebinds
  // only afterwards, and `mountClientSceneLoad`'s failure path retires across an
  // `await`. So retirement parks the renderer here and the context is released
  // only once no live holder points at it, which for the normal crossing path is
  // the moment the new renderer is bound and drawing.
  const pendingContextRelease = new Set();
  let releasedContextCount = 0;

  function rendererStillReferenced(renderer) {
    const impl = currentScene && currentScene._impl;
    if (impl && impl.renderer === renderer) return true;
    if (previewManager) {
      // Fail safe on an unrecognised preview manager. This gate depends on a
      // field owned by another module; if that contract ever changes, the safe
      // reading is "still referenced", because never releasing costs memory
      // while releasing too early kills a context the demo is drawing with.
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
    return { scene: impl.scene, camera: impl.camera, renderer: impl.renderer };
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
          throw new Error("canonical portal destination resolver is unavailable");
        }
        return capabilities.resolvePortalDestinationContent(entry);
      },
      composeDestinationContent: (content, context) => {
        if (content?.kind === "legacy_world") {
          const scene = new THREE.Scene();
          scene.background = new THREE.Color(0x0b1020);
          const inventory = mountCanonicalWorldContent(
            scene,
            THREE,
            content.world,
          );
          const hostedMeshes = new Map();
          const presentation = {
            ...inventory,
            hosted_objects: {
              attach_point_id: null,
              version: null,
              refresh_owner: "PortalRenderController existing bounded client pull",
              refresh_cadence_ms: 100,
              streaming: false,
              objects: [],
            },
          };
          const composition = {
            scene,
            source: inventory.source,
            revision: content.revision,
            semantic_inventory: inventory.semantic_inventory,
            inventory_revision: 0,
            presentation,
            update: null,
            dispose: null,
          };
          const applyHostedPoint = (attachPoint) => {
            if (!attachPoint || attachPoint.version === presentation.hosted_objects.version) return;
            const synced = syncHostedSceneObjectMeshes({
              THREE,
              meshes: hostedMeshes,
              parent: scene,
              objects: attachPoint.value?.objects || [],
              version: attachPoint.version,
            });
            if (synced.structure_changed) composition.inventory_revision += 1;
            composition.revision =
              `${content.location_id}:${content.world_id}:hosted-${attachPoint.version ?? "unknown"}`;
            composition.semantic_inventory = [
              ...inventory.semantic_inventory,
              ...synced.object_ids.map((id) => `demo-scene-object-${id}`),
            ];
            presentation.hosted_objects = {
              attach_point_id: attachPoint.attach_point_id || null,
              version: attachPoint.version ?? null,
              refresh_owner: "PortalRenderController existing bounded client pull",
              refresh_cadence_ms: 100,
              streaming: false,
              objects: Array.from(hostedMeshes.values(), (mesh) => ({
                ...mesh.userData.hostedSceneObject,
                scene_name: mesh.name,
                position: [mesh.position.x, mesh.position.y, mesh.position.z],
                instance_count: 1,
              })),
            };
          };
          applyHostedPoint(content.hosted_point);
          const unsubscribe = typeof content.subscribeHostedPoint === "function"
            ? content.subscribeHostedPoint(applyHostedPoint)
            : null;
          composition.dispose = () => {
            try { unsubscribe?.(); } catch {}
            disposeHostedSceneObjectMeshes(hostedMeshes);
          };
          return composition;
        }
        if (content?.kind !== "authored_wow_graph" || !content.graph) {
          throw new Error("portal destination has no canonical scene authority");
        }
        const width = Math.max(1, Number(context?.width) || 1);
        const height = Math.max(1, Number(context?.height) || 1);
        const built = buildWowScene(content.graph, THREE, {
          width,
          height,
          source: "portal_canonical_authored_wow_graph",
        });
        const airportTerminal = mountAirportTerminalContent(
          content.graph,
          built,
          THREE,
          { document: documentTarget, motionPreference, hudOverlay: false },
        );
        // buildWowScene's grid/gizmos are diagnostics, not authored content.
        hideStageDebugVisuals(built.scene, true);
        const assetState = {
          status: built.asset_nodes?.length ? "pending" : "settled",
          requested: built.asset_nodes?.length || 0,
          loaded: 0,
          failed: 0,
        };
        let disposed = false;
        if (built.asset_nodes?.length) {
          void mountWowSceneAssets(built.asset_nodes, THREE, {
            loadGltf,
            cloneScene,
            cache: destinationAssetCache,
            shouldMount: () => !disposed,
            baseUrl: content.base_url || content.graph_url || locationHref,
            onAsset: (item, model, assetRecord) => {
              void built.airport_entity_runtime?.attachAsset(item, model, assetRecord);
            },
          }).then((summary) => Object.assign(assetState, summary, { status: "settled" }))
            .catch((error) => Object.assign(assetState, {
              status: "error",
              error: error?.message || String(error),
            }));
        }
        return {
          scene: built.scene,
          source: "shared_buildWowScene+mountAirportTerminalContent",
          revision: content.revision,
          semantic_inventory: Array.from(
            built.scene.children || [],
            (node) => node.name || node.type,
          ),
          presentation: {
            graph_spatial_id: content.graph.spatialID || content.world_id,
            airport_terminal: airportTerminal,
            render_summary: built.render_summary,
            assets: assetState,
          },
          update: (seconds, camera) => built.airport_entity_runtime?.update(seconds, camera),
          dispose: () => {
            disposed = true;
            built.airport_hud_overlay?.dispose();
            built.airport_entity_runtime?.dispose();
          },
        };
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
      manager.bindScene(impl.renderer, impl.camera, impl.scene);
    } else {
      manager.bindScene(null, null, null);
    }
    if (validPortalKeys) manager.pruneToPortalKeys(validPortalKeys);
    // The rebind above is the only thing that clears the preview manager's
    // cached renderer, so it is also the first point at which a renderer
    // retired before it could be released is provably unreferenced.
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
  const AUTHORED_AIRPORT_LOCATION_ID = "location-airport";
  const AUTHORED_AIRPORT_SPATIAL_ID = "world-airport-terminal";

  function isAuthoredAirportWorld(world, resolved) {
    return world?.location_id === AUTHORED_AIRPORT_LOCATION_ID &&
      resolved?.spatialID === AUTHORED_AIRPORT_SPATIAL_ID;
  }

  function publishAuthoredSceneWorld(world, resolved) {
    documentTarget.body.setAttribute(
      "data-authored-scene-world",
      String(resolved?.spatialID || world?.world_id || ""),
    );
    if (isAuthoredAirportWorld(world, resolved)) {
      documentTarget.body.setAttribute("data-airport-backend-scene", "1");
    } else {
      documentTarget.body.removeAttribute("data-airport-backend-scene");
    }
  }

  // `data-airport-terminal-ready` is the same defect class repaired
  // for `data-airport-backend-scene`, so it gets the same shape rather than a
  // second pattern: `data-terminal-ready-world` names the world whose airport-
  // terminal content is mounted and ready, and the airport-specific alias is
  // published only when that world IS the airport. Both publication sites (the
  // live authored mount and the client scene load) route through this one helper,
  // and both clear paths remove the pair together, so the two attributes share a
  // single lifecycle and neither can outlive the scene it describes.
  function publishTerminalReadyWorld(spatialId) {
    const mountedWorldId = String(spatialId || "");
    documentTarget.body.setAttribute("data-terminal-ready-world", mountedWorldId);
    if (mountedWorldId === AUTHORED_AIRPORT_SPATIAL_ID) {
      documentTarget.body.setAttribute("data-airport-terminal-ready", "1");
    } else {
      documentTarget.body.removeAttribute("data-airport-terminal-ready");
    }
  }

  // generalized render selector. A world renders
  // through the authored-graph path iff its backend ADVERTISED a ready authored
  // graph — the data-driven `resolved.authored_graph` flag set by the live
  // adapter's `_resolveWowSceneGraph` from
  // `webofworlds_extension.authored_graph.endpoint`. There is deliberately NO
  // world-identity literal here: the airport answers "yes" today only because it
  // is the sole world whose 041 config carries `authored_wow_graph`; A/B/lobby
  // answer "no" and fall back to the procedural placeholder, visually unchanged.
  // Any world flips to authored the moment its config advertises a graph — a
  // later, content-gated step, not this one. Reverting to airport-only behavior
  // is a one-line change (re-add the two identity guards) and does not disturb
  // the airport, which selects "yes" under either predicate.
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
    documentTarget.body.removeAttribute("data-terminal-ready-world");
    documentTarget.body.removeAttribute("data-airport-terminal-ready");
    documentTarget.body.removeAttribute("data-wow-asset-nodes");
    documentTarget.body.removeAttribute("data-wow-assets-loaded");
    documentTarget.body.removeAttribute("data-wow-assets-failed");
    delete windowTarget.__airportBackendScene;
  }

  /** Mount backend-hosted authored airport data through the existing selected
   * renderer lifecycle. The previous scene is disposed before this one is
   * published, so this is one renderer/scene, never a procedural overlay. */
  function mountLiveAuthoredAirport({ world, resolved, phase, reason }) {
    const host = mount();
    const width = (host && host.clientWidth) || 1100;
    const height = (host && host.clientHeight) || 660;
    const built = buildWowScene(resolved.graph, THREE, {
      width,
      height,
      source: "live_backend_authored_wow_graph",
    });
    const airportTerminal = mountAirportTerminalContent(
      resolved.graph,
      built,
      THREE,
      { document: documentTarget, motionPreference },
    );
    if (!airportTerminal?.walkable_surface?.entry_ground?.ok) {
      throw new Error("live airport authored graph has no rendered entry ground");
    }
    hideStageDebugVisuals(built.scene);
    const renderState = { frames: 0, error: null, renderer_kind: null, width, height };
    let alignment = null;
    const next = mountAlternateRenderer({
      built,
      renderState,
      width,
      height,
      world,
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
    const assetNodes = built.asset_nodes || [];
    const assetState = {
      status: assetNodes.length ? "pending" : "settled",
      requested: assetNodes.length,
      loaded: 0,
      failed: 0,
    };
    // The committed procedural airport is already complete at this point. Delay
    // progressive GLB clones until traversal releases ownership of the handoff
    // fence, then preserve the existing one-mount-per-frame pacing.
    let transferReadyPromise = null;
    if (assetNodes.length) {
      void mountWowSceneAssets(assetNodes, THREE, {
        loadGltf,
        cloneScene,
        cache: destinationAssetCache,
        shouldMount: () => currentScene === next,
        beforeMount: () => {
          if (!transferReadyPromise) {
            transferReadyPromise = new Promise((resolve) => {
              const waitForTransfer = () => {
                const capabilities = runtime();
                const handoffInFlight = capabilities?.isHandoffInFlight?.() === true;
                if (currentScene !== next || !handoffInFlight) {
                  resolve();
                  return;
                }
                requestFrame(waitForTransfer);
              };
              waitForTransfer();
            });
          }
          return transferReadyPromise.then(
            () => new Promise((resolve) => requestFrame(() => resolve()))
          );
        },
        baseUrl: resolved.graph_url || resolved.base_url || locationHref,
        onAsset: (item, model, assetRecord) => {
          void built.airport_entity_runtime?.attachAsset(item, model, assetRecord);
        },
      }).then((summary) => {
        Object.assign(assetState, summary, { status: "settled" });
        documentTarget.body.setAttribute("data-wow-assets-loaded", String(summary.loaded));
        documentTarget.body.setAttribute("data-wow-assets-failed", String(summary.failed));
      }).catch((error) => {
        Object.assign(assetState, {
          status: "error",
          error: (error && error.message) || String(error),
        });
        logLine(`live airport asset ingest failed: ${assetState.error}`);
      });
    }
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
    publishAuthoredSceneWorld(world, resolved);
    publishTerminalReadyWorld(resolved?.spatialID || world?.world_id);
    documentTarget.body.setAttribute("data-wow-asset-nodes", String(assetNodes.length));
    documentTarget.body.setAttribute("data-wow-assets-loaded", "0");
    documentTarget.body.setAttribute("data-wow-assets-failed", "0");
    windowTarget.__airportBackendScene = liveAuthoredSceneSurface;
    const title = documentTarget.getElementById("loc-title");
    const meta = documentTarget.getElementById("loc-meta");
    const backend = documentTarget.getElementById("live-backend");
    if (title) title.textContent = world.title;
    if (meta) meta.textContent = `${world.location_id} · ${world.world_id} · ${world.session_id}`;
    if (backend) {
      backend.textContent = `${runtime()?.base || ""} · authored /wow/graph`;
      backend.style.color = "var(--ok)";
    }
    logLine(
      `live airport authored scene mounted (${reason || "live_mount"}): ` +
        `${airportTerminal.storefront_count} storefronts, ${airportTerminal.npc_count} travelers, ` +
        `one selected renderer`,
    );
    return next;
  }

  function mountLive({ world, sceneRole, phase, reason = "live_mount" }) {
    if (disposed) throw new Error("scene runtime disposed");
    const authoredGraph = activeAuthoredGraph(world);
    if (authoredGraph) {
      clearClientScenePublication();
      return mountLiveAuthoredAirport({
        world,
        resolved: authoredGraph,
        phase,
        reason,
      });
    }
    clearLiveAuthoredPublication();
    disposeCurrent("scene dispose during live mount failed");
    const next = new SceneClass(mount(), sceneRole, world);
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
    documentTarget.body.removeAttribute("data-terminal-ready-world");
    documentTarget.body.removeAttribute("data-airport-terminal-ready");
    documentTarget.body.removeAttribute("data-wow-asset-nodes");
    documentTarget.body.removeAttribute("data-wow-assets-loaded");
    documentTarget.body.removeAttribute("data-wow-assets-failed");
    delete windowTarget.__airportLobbySceneLoad;
    if (windowTarget.__assembly) windowTarget.__assembly.clientSceneLoad = () => null;
  }

  function recomposeLive(reason) {
    const capabilities = runtime();
    if (!isPlayer || !capabilities || !capabilities.world) return null;
    const world = capabilities.world;
    if (clientSceneLoadSurface && activeClientSceneGraph && world.location_id === clientSceneLoadSurface.target.spatial_id) {
      const host = mount();
      const width = (host && host.clientWidth) || 1100;
      const height = (host && host.clientHeight) || 660;
      const built = buildWowScene(activeClientSceneGraph.graph, THREE, {
        width,
        height,
        source: activeClientSceneGraph.source,
      });
      const airportTerminal = mountAirportTerminalContent(activeClientSceneGraph.graph, built, THREE, { document: documentTarget, motionPreference });
      if (!airportTerminal) throw new Error("airport scene recomposition lost terminal content");
      hideStageDebugVisuals(built.scene);
      const renderState = { frames: 0, error: null, renderer_kind: null, width, height };
      const next = mountAlternateRenderer({ built, renderState, width, height });
      rehostAvatarLayers({ avatar: capabilities.avatar() });
      if (typeof syncPeerAvatars === "function") syncPeerAvatars(capabilities.debugState());
      const entries = Array.isArray(world.portals) ? world.portals : [];
      const alignment = typeof alignPortalVisual === "function"
        ? alignPortalVisual(next, world)
        : null;
      if (typeof onPortalAlignment === "function") onPortalAlignment(alignment);
      bindPreviewToCurrent(entries.map((entry) => portalKey(entry)));
      clientSceneLoadSurface.airport_terminal = airportTerminal;
      clientSceneLoadSurface.recomposition = {
        reason: reason || "client_scene_recomposition",
        scene_identity: sceneIdentity,
        ground_contract_source: airportTerminal.walkable_surface.source,
      };
      const assetNodes = built.asset_nodes || [];
      if (assetNodes.length) {
        void mountWowSceneAssets(assetNodes, THREE, {
          loadGltf,
          cloneScene,
          cache: destinationAssetCache,
          baseUrl: activeClientSceneGraph.base_url || activeClientSceneGraph.graph_url || locationHref,
          onAsset: (item, model, assetRecord) => {
            void built.airport_entity_runtime?.attachAsset(item, model, assetRecord);
          },
        }).catch((error) => logLine(`airport recomposition asset ingest failed: ${(error && error.message) || String(error)}`));
      }
      if (typeof applyPlayerCamera === "function") applyPlayerCamera();
      logLine(`airport scene recomposed (${reason || "client_scene_recomposition"}); grounding contract rebound from local world data`);
      return next;
    }
    const next = mountLive({
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
      implementation.renderer.render(implementation.scene, implementation.camera);
    }
    const title = documentTarget.getElementById("loc-title");
    const meta = documentTarget.getElementById("loc-meta");
    const backend = documentTarget.getElementById("live-backend");
    if (title) title.textContent = world.title;
    if (meta) meta.textContent = `${world.location_id} · ${world.world_id} · ${world.session_id}`;
    if (backend) {
      backend.textContent = capabilities.base;
      backend.style.color = "var(--ok)";
    }
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
    const renderer = impl.renderer;
    const previousTarget = renderer.getRenderTarget();
    if (!pass._prevClearColor) pass._prevClearColor = new THREE.Color();
    renderer.getClearColor(pass._prevClearColor);
    const previousAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(pass.renderTarget);
    renderer.setClearColor(pass.clearColor, 1);
    renderer.clear();
    renderer.render(impl.scene, pass.camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(pass._prevClearColor, previousAlpha);
    if (capabilities && typeof capabilities.markChildFabricPreviewFrame === "function") {
      capabilities.markChildFabricPreviewFrame();
    }
  }

  function mountAlternateRenderer({ built, renderState, width, height, world = null, beforeFirstRender = null }) {
    if (disposed) throw new Error("scene runtime disposed");
    if (!built || !built.scene || !built.camera) throw new Error("alternate renderer requires a built scene");
    disposeCurrent("scene dispose during alternate mount failed");
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    const host = mount();
    if (host) {
      // The scene mount also owns the notification, destination, selector,
      // and runtime-tweak UI. The disposed scene already removes its canvas;
      // preserve those non-render children when installing the next renderer.
      host.appendChild(renderer.domElement);
    }
    renderState.renderer_kind = "three-webgl";
    let frame = 0;
    let stopped = false;
    let previousFrameTime = null;
    const renderOnce = () => {
      if (stopped) return;
      try {
        renderer.render(built.scene, built.camera);
        renderState.frames += 1;
      } catch (error) {
        renderState.error = (error && error.message) || String(error);
      }
    };
    const loop = (timestamp) => {
      const seconds = previousFrameTime == null ? 0 : (Number(timestamp) - previousFrameTime) / 1000;
      previousFrameTime = Number(timestamp);
      built.airport_entity_runtime?.update(seconds, built.camera);
      renderOnce();
      if (!stopped) frame = requestFrame(loop);
    };
    const next = {
      _impl: { scene: built.scene, camera: built.camera, renderer },
      world,
      rendererKind: "webgl",
      setPhase() {},
      setAvatar() {},
      resize() {},
      dispose() {
        if (stopped) return;
        stopped = true;
        if (frame) cancelFrame(frame);
        frame = 0;
        try { built.airport_hud_overlay?.dispose(); } catch {}
        try { built.airport_entity_runtime?.dispose(); } catch {}
        try { renderer.dispose(); } catch {}
        if (renderer.domElement && renderer.domElement.parentNode) {
          renderer.domElement.parentNode.removeChild(renderer.domElement);
        }
        // The canvas is already detached here, so the context release below can
        // only ever fire against a surface that is out of the document.
        retireRendererContext(renderer);
      },
    };
    publishScene(next);
    resize();
    bindPreviewToCurrent();
    if (typeof beforeFirstRender === "function") beforeFirstRender(next);
    built.airport_entity_runtime?.update(0, built.camera);
    renderOnce();
    frame = requestFrame(loop);
    return next;
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

  async function mountClientSceneLoad(target) {
    const capabilities = runtime();
    if (!capabilities || !isPlayer) throw new Error("client scene load requires the player runtime");
    if (clientSceneLoadInFlight) throw new Error("client scene load already in flight");
    clientSceneLoadInFlight = true;
    let replacementScene = null;
    try {
      if (target && target.transition === "client_scene_return") {
        if (typeof capabilities.beginVisualTransition === "function") {
          capabilities.beginVisualTransition({
            kind: "client_scene_return",
            source_location_id: capabilities.world?.location_id || null,
            target_location_id: target.spatial_id || "location-lobby",
          });
        }
        const returned = await capabilities.returnFromClientSceneLoad({
          reciprocalPortalId: target.portal_id,
        });
        if (!returned || !returned.ok) {
          if (typeof capabilities.abortVisualTransition === "function") {
            capabilities.abortVisualTransition({ restore: false });
          }
          throw new Error(returned && returned.reason ? returned.reason : "runtime rejected reciprocal scene return");
        }
        return returned;
      }
      const resolved = await capabilities.resolveClientSceneLoad(target);
      const contract = airportSceneContract(resolved.graph, target);
      if (!contract) throw new Error("airport graph failed its scene-load contract");
      const host = mount();
      const width = (host && host.clientWidth) || 1100;
      const height = (host && host.clientHeight) || 660;
      const built = buildWowScene(resolved.graph, THREE, { width, height, source: resolved.source });
      const airportTerminal = mountAirportTerminalContent(resolved.graph, built, THREE, { document: documentTarget, motionPreference });
      if (!airportTerminal) throw new Error("airport graph did not mount airport-terminal content");
      const groundContract = airportTerminal.walkable_surface;
      if (!groundContract?.entry_ground?.ok) throw new Error("airport entry spawn has no rendered walkable surface");
      contract.entry_spawn.position[1] = groundContract.entry_ground.surface_y_m;
      hideStageDebugVisuals(built.scene);
      const walkable = built.render_summary && built.render_summary.walkable_extent
        ? built.render_summary.walkable_extent
        : null;
      const surfaceBounds = groundContract.surfaces.reduce((bounds, surface) => {
        const halfX = surface.size_m[0] / 2;
        const halfZ = surface.size_m[2] / 2;
        bounds.minX = Math.min(bounds.minX, surface.center_m[0] - halfX);
        bounds.maxX = Math.max(bounds.maxX, surface.center_m[0] + halfX);
        bounds.minZ = Math.min(bounds.minZ, surface.center_m[2] - halfZ);
        bounds.maxZ = Math.max(bounds.maxZ, surface.center_m[2] + halfZ);
        return bounds;
      }, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
      const bounds = Number.isFinite(surfaceBounds.minX) ? surfaceBounds : null;
      const renderState = { frames: 0, error: null, renderer_kind: null, width, height };
      if (typeof capabilities.beginVisualTransition === "function") {
        capabilities.beginVisualTransition({
          kind: "client_scene_load",
          source_location_id: capabilities.world?.location_id || null,
          target_location_id: contract.spatial_id,
        });
      }
      const entered = await capabilities.enterClientSceneLoad({ target, contract, resolved, bounds });
      if (!entered || !entered.ok) {
        throw new Error(entered && entered.reason ? entered.reason : "runtime rejected client scene load");
      }
      // `getRuntime()` returns a deliberately small snapshot facade. Re-read it
      // after installing the client scene so portal rendering uses the newly
      // composed destination world rather than the lobby snapshot captured at
      // the start of this asynchronous transition.
      if (typeof seedOrbitCamera === "function") {
        seedOrbitCamera({ azimuth: Math.PI, avatarPosition: contract.entry_spawn.position });
      }
      // Release the staged destination state and publish its HUD projection,
      // then mount/rehost/map synchronously before this browser turn can yield.
      if (typeof capabilities.commitVisualTransition === "function") {
        capabilities.commitVisualTransition({ emit: true });
      }
      const destinationCapabilities = runtime() || capabilities;
      const reciprocalEntries = Array.isArray(destinationCapabilities.world?.portals)
        ? destinationCapabilities.world.portals
        : [];
      let alignment = null;
      replacementScene = mountAlternateRenderer({
        built,
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
      const title = resolved.graph.title || "Denver Skyport";
      const titleElement = documentTarget.getElementById("loc-title");
      const metaElement = documentTarget.getElementById("loc-meta");
      const backendElement = documentTarget.getElementById("live-backend");
      if (titleElement) titleElement.textContent = title;
      if (metaElement) metaElement.textContent = `${contract.spatial_id} · client scene load · same player session`;
      if (backendElement) {
        backendElement.textContent = `${target.graph_endpoint} (local-data-backed scene; no backend handoff)`;
        backendElement.style.color = "var(--muted, #9aa)";
      }
      documentTarget.body.setAttribute("data-client-scene-load", "airport");
      publishTerminalReadyWorld(contract?.spatial_id || resolved?.spatialID);
      documentTarget.body.setAttribute("data-wow-asset-nodes", String((built.asset_nodes || []).length));
      documentTarget.body.setAttribute("data-wow-assets-loaded", "0");
      documentTarget.body.setAttribute("data-wow-assets-failed", "0");
      const assetNodes = built.asset_nodes || [];
      const assetState = {
        status: assetNodes.length ? "pending" : "settled",
        requested: assetNodes.length,
        loaded: 0,
        failed: 0,
      };
      if (assetNodes.length) {
        const assetBaseUrl = resolved.base_url || resolved.graph_url || locationHref;
        void mountWowSceneAssets(assetNodes, THREE, {
          loadGltf,
          cloneScene,
          cache: destinationAssetCache,
          baseUrl: assetBaseUrl,
          onAsset: (item, model, assetRecord) => {
            void built.airport_entity_runtime?.attachAsset(item, model, assetRecord);
            logLine(
              `airport asset ${item.status}: ${item.label}` +
                `${item.from_cache ? " (cache)" : ""}${item.error ? " — " + item.error : ""}`
            );
          },
        }).then((summary) => {
          Object.assign(assetState, summary, { status: "settled" });
          documentTarget.body.setAttribute("data-wow-assets-loaded", String(summary.loaded));
          documentTarget.body.setAttribute("data-wow-assets-failed", String(summary.failed));
          logLine(`airport assets settled: loaded=${summary.loaded} failed=${summary.failed}`);
        }).catch((error) => {
          Object.assign(assetState, { status: "error", error: (error && error.message) || String(error) });
          logLine(`airport asset ingest failed: ${assetState.error}`);
        });
      }
      clientSceneLoadSurface = {
        target,
        contract,
        graph: {
          spatialID: resolved.spatialID,
          graph_url: resolved.graph_url,
          node_count: resolved.node_count,
        },
        airport_terminal: airportTerminal,
        walkable_extent: walkable,
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
          adapter: capabilities.debugState().client_scene_load,
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
    } catch (error) {
      if (replacementScene && currentScene === replacementScene) disposeCurrent("airport scene dispose after failure failed");
      else disposeScene(replacementScene, "airport scene dispose after failure failed");
      const debug = typeof capabilities.rawDebugState === "function"
        ? capabilities.rawDebugState()
        : capabilities.debugState();
      if (debug && debug.client_scene_load && debug.client_scene_load.active) {
        await capabilities.returnFromClientSceneLoad();
      } else if (capabilities.world) {
        recomposeLive("client_scene_load_failed");
      }
      if (typeof capabilities.abortVisualTransition === "function") {
        capabilities.abortVisualTransition({ restore: false });
      }
      throw error;
    } finally {
      clientSceneLoadInFlight = false;
    }
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
    if (previewManager) previewManager.dispose();
    previewManager = null;
    disposeCurrent("scene runtime dispose failed");
    // Nothing can hold a renderer past this point, so drain anything that was
    // still parked when the runtime went down.
    releaseRetiredContexts();
    clearClientScenePublication();
    clearLiveAuthoredPublication();
  }

  return Object.freeze({
    scene: () => currentScene,
    rendererKind: () => currentScene ? currentScene.rendererKind : null,
    avatarHost: sceneHost,
    rehostAvatarLayers,
    hideStageDebugVisuals,
    mountLive,
    recomposeLive,
    mountAlternateRenderer,
    mountClientSceneLoad,
    renderChildFabricPreview: renderChildFabricPreviewPass,
    refreshNavigator: () => {
      if (typeof setupNavigatorRender === "function") setupNavigatorRender();
    },
    renderPortalPreviews: () => { if (previewManager) previewManager.renderActive(); },
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
    destinationAssetCache: () => destinationAssetCache,
    samplePortalApertureTexels: (key, points) => previewManager
      ? previewManager.sampleApertureTexels(key, points)
      : null,
    probeVisiblePixels,
    cameraSpaceOfPoint,
    clientSceneLoad: () => clientSceneLoadSurface,
    liveAuthoredScene: () => liveAuthoredSceneSurface,
    clientSceneLoadInFlight: () => clientSceneLoadInFlight,
    resize,
    viewportDebug,
    debug: () => ({
      selected_runtime: currentScene ? currentScene.rendererKind : null,
      client_scene_load_in_flight: clientSceneLoadInFlight,
      client_scene_load_active: !!clientSceneLoadSurface,
      live_authored_scene_active: !!liveAuthoredSceneSurface,
      portal_preview_bound: !!previewManager,
      // the leak this closes was invisible because nothing
      // recorded context lifetime. `webgl_contexts_awaiting_release` is the
      // oracle — it is transiently 1 during a crossing and must settle back to
      // 0. A rising value means retired renderers are being kept alive by a
      // reference that outlives them.
      webgl_contexts_released: releasedContextCount,
      webgl_contexts_awaiting_release: pendingContextRelease.size,
      disposed,
    }),
    dispose,
  });
}
