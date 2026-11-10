import {
  mountLiveInclusions,
  environmentAwareClone,
} from "./wow-inclusion-mount.mjs";
import { mountViewControls } from "./wow-view-controls.mjs";
import { mountViewerPortals } from "./main-demo-viewer-portals.mjs";

/** The scene runtime owns this graph presentation and its asynchronous publications. */
export function createWowScenePresentation({
  THREE,
  resolved,
  loadError,
  mount,
  document,
  view,
  motionPreference,
  buildWowScene,
  mountAirportTerminalContent,
  mountWowSceneAssets,
  loadGltf,
  cloneScene,
  cache,
  sceneDescription,
  composeRenderer,
  mountRenderer,
  publishTerminal,
  hideStageDebugVisuals,
  visitorPosition,
  logLine,
}) {
  const width = mount?.clientWidth || 1100,
    height = mount?.clientHeight || 660;
  const renderState = {
    frames: 0,
    error: loadError,
    renderer_kind: null,
    width,
    height,
  };
  let built = null,
    terminal = null,
    runtime = null,
    controls = null,
    inclusions = null,
    portals = null,
    disposed = false;
  const removers = [];
  const active = () => !disposed;
  let inclusionHost = null,
    baseUrl = null;
  function configureAssetLocation() {
    const graphHref = resolved?.graph_url
      ? new URL(resolved.graph_url, view.location.href).href
      : null;
    inclusionHost =
      resolved?.source === "canonical-walk" &&
      graphHref &&
      /^https?:/i.test(graphHref)
        ? graphHref
        : null;
    const localFixture =
      !inclusionHost &&
      !!graphHref &&
      new URL(graphHref).origin === view.location.origin;
    baseUrl = localFixture
      ? graphHref
      : resolved?.base_url || resolved?.graph_url || view.location.href;
  }
  const assetOptions = () => ({
    loadGltf,
    cloneScene: environmentAwareClone(cloneScene),
    cache,
    baseUrl,
    shouldMount: active,
  });
  function build(renderAdapter) {
    built = buildWowScene(resolved.graph, THREE, {
      width,
      height,
      source: resolved.source,
      sceneDescription: sceneDescription(resolved.graph),
    });
    terminal = mountAirportTerminalContent(resolved.graph, built, THREE, {
      document,
      motionPreference,
    });
    hideStageDebugVisuals(built.scene);
    const counts = built.render_summary.rendered;
    renderState.asset_load = {
      status: "pending",
      requested: (built.asset_nodes || []).length,
    };
    logLine(
      `M2 wow: built scene — rendered_nodes=${counts.rendered_nodes} asset_placeholders=${counts.asset_placeholders} group_gizmos=${counts.group_gizmos} (glTF assets loading async — runtime)`
    );
    runtime = mountRenderer({
      built,
      renderState,
      width,
      height,
      renderAdapter,
    });
    return runtime;
  }
  function loadIncludedModels(nodes) {
    if (active() && nodes.length)
      void mountWowSceneAssets(nodes, THREE, assetOptions());
  }
  async function resolveModels() {
    const nodes = built.asset_nodes || [];
    if (!inclusionHost) return nodes;
    try {
      const mounted = await mountLiveInclusions({
        built,
        hostUrl: inclusionHost,
        THREE,
        buildWowScene,
        document,
        fetch: view.fetch.bind(view),
        WebSocket: view.WebSocket,
        onModels: loadIncludedModels,
        onUpdate: (summary, live) => {
          if (!active()) return;
          view.__wowInclusions = { summary, live: live.live };
          document.body.setAttribute(
            "data-wow-live-updates",
            String(live.live.updates)
          );
        },
      });
      if (!active()) {
        mounted.live.close();
        mounted.current().undo();
        return [];
      }
      inclusions = mounted;
      view.__wowInclusions = {
        summary: mounted.summary,
        composition: mounted.composition,
        live: mounted.live.live,
      };
      document.body.setAttribute(
        "data-wow-inclusions",
        JSON.stringify(mounted.summary.by_status)
      );
      logLine(
        `wow inclusions: ${mounted.summary.graphs_shown} graph(s) shown, ${mounted.summary.placeholders.length} placeholder(s), ${mounted.summary.cycles} cycle(s)`
      );
      return mounted.modelNodes;
    } catch (error) {
      if (active()) logLine(`wow inclusions ERROR: ${error?.message || error}`);
      return nodes;
    }
  }
  async function loadModels() {
    const nodes = await resolveModels();
    if (!active()) return;
    document.body.setAttribute("data-wow-inclusions-ready", "1");
    if (!nodes.length) {
      Object.assign(renderState.asset_load, {
        status: "settled",
        loaded: 0,
        failed: 0,
        note: "no spatialAssetURI nodes in this graph",
      });
      document.body.setAttribute("data-wow-assets-loaded", "0");
      return;
    }
    try {
      const summary = await mountWowSceneAssets(nodes, THREE, {
        ...assetOptions(),
        onAsset: (asset, model, record) => {
          if (!active()) return;
          void built.airport_entity_runtime?.attachAsset(asset, model, record);
          logLine(
            `M2 wow asset ${asset.status}: ${asset.label}${
              asset.from_cache ? " (cache)" : ""
            }${asset.error ? " — " + asset.error : ""}`
          );
        },
      });
      if (!active()) return;
      Object.assign(renderState.asset_load, summary, { status: "settled" });
      document.body.setAttribute(
        "data-wow-assets-loaded",
        String(summary.loaded)
      );
      document.body.setAttribute(
        "data-wow-assets-failed",
        String(summary.failed)
      );
      logLine(
        `M2 wow: glTF ingest settled — loaded=${summary.loaded} failed=${summary.failed} network=${summary.network_loads} cache_hits=${summary.cache_hits} (real assets via reused avatar GLTFLoader)`
      );
    } catch (error) {
      if (!active()) return;
      Object.assign(renderState.asset_load, {
        status: "error",
        error: error?.message || String(error),
      });
      document.body.setAttribute("data-wow-assets-loaded", "0");
      logLine(`M2 wow: glTF ingest ERROR: ${renderState.asset_load.error}`);
    }
  }
  function bindControls() {
    const canvas = runtime?._impl?.renderer?.domElement;
    controls = canvas
      ? mountViewControls({
          THREE,
          camera: built.camera,
          canvas,
          document,
          window: view,
          onPick: (id) => view.__wowPortals?.cross?.(id),
        })
      : null;
    view.__wowViewControls = controls;
    document.body.setAttribute(
      "data-wow-asset-nodes",
      String((built.asset_nodes || []).length)
    );
    if (inclusionHost)
      portals = mountViewerPortals({
        THREE,
        document,
        built,
        hostUrl: inclusionHost,
        buildWowScene,
        canvas,
        viewControls: controls,
        onModels: loadIncludedModels,
        visitorPosition,
        logLine,
        listen: (target, type, listener) => {
          target.addEventListener(type, listener);
          removers.push(() => target.removeEventListener(type, listener));
        },
      });
  }
  async function start() {
    try {
      if (!resolved?.graph) throw new Error(loadError || "no graph resolved");
      configureAssetLocation();
      await composeRenderer(build);
      if (!active())
        throw Object.assign(new Error("scene presentation disposed"), {
          name: "AbortError",
        });
      if (terminal) {
        publishTerminal(resolved.spatialID);
        logLine(
          `runtime airport: mounted ${terminal.storefront_count} storefronts, ${terminal.npc_count} NPC travelers, destination ${terminal.gate.gate}`
        );
      }
      bindControls();
      void loadModels();
    } catch (error) {
      if (!runtime) {
        try { built?.airport_hud_overlay?.dispose(); } catch {}
        try { built?.airport_entity_runtime?.dispose(); } catch {}
        built = null;
        terminal = null;
      }
      if (!active() || error?.name === "AbortError") throw error;
      renderState.error = error?.message || String(error);
      logLine(`M2 wow RENDER ERROR: ${renderState.error}`);
    }
    return { built, alternateRuntime: runtime, renderState };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    controls?.dispose();
    portals?.dispose();
    inclusions?.live.close();
    inclusions?.current().undo();
    for (const remove of removers.splice(0).reverse()) remove();
  }
  return { start, dispose, runtime: () => runtime };
}
