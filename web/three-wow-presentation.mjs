import {
  mountLiveInclusions,
  environmentAwareClone,
} from "./wow-inclusion-mount.mjs";
import { mountViewControls } from "./wow-view-controls.mjs";
import { mountViewerPortals } from "./main-demo-viewer-portals.mjs";
import { mountWowExtensions } from "./wow-extension-mount.mjs";
import { createGrantStore, renderExtensionsPanel } from "./wow-extension-consent.mjs";
import { attachExtensionPointer } from "./wow-extension-pointer.mjs";
import { renderGlanceList } from "./wow-extension-glance.mjs";
import { renderPanelHost } from "./wow-extension-panel.mjs";

// The extension host, loaded only when a world carries extensions. The Lab frontend serves runtime/extension-host/ at
// /vendor/extension-host/, beside /vendor/scene-core/.
const EXTENSION_HOST_URL = new URL("./vendor/extension-host/extension-host.mjs", import.meta.url).href;

// The page's localStorage (remembered grants and the extensions' storage), or null where it cannot be read.
function pageStorage(view) {
  try {
    const storage = view?.localStorage || null;
    if (storage) storage.getItem("ue-grants:");
    return storage;
  } catch {
    return null;
  }
}
// One grant store per page, so a grant allowed for this page session holds across worlds shown in it.
let pageGrants = null;
function grantStoreFor(view) {
  if (!pageGrants) pageGrants = createGrantStore({ storage: pageStorage(view) });
  return pageGrants;
}

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
  loadExtension = null,
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
    extensions = null,
    extensionUi = null,
    disposed = false;
  const removers = [];
  const active = () => !disposed;
  let inclusionHost = null,
    baseUrl = null,
    worldHref = null;
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
    worldHref = graphHref;
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
  // The extensions the world's nodes carry (`webofworlds_extension.universal_extensions`), after the models. A world
  // with none does nothing here. Refusals and failures are drawn as labeled markers and never break the world. Nothing
  // is fetched for an extension until the visitor selects its glance (web/wow-extension-glance.mjs).
  async function loadExtensions() {
    const nodes = built?.extension_nodes || [];
    if (!active() || !nodes.length) return;
    let host = loadExtension;
    if (!host) {
      try {
        host = (await import(EXTENSION_HOST_URL)).loadExtension;
      } catch (error) {
        host = null;
        logLine(`wow extensions: the extension host did not load: ${error?.message || error}`);
      }
    }
    if (!active()) return;
    const storage = pageStorage(view);
    const mounted = await mountWowExtensions(nodes, THREE, {
      loadExtension: host,
      worldUrl: worldHref,
      pageOrigin: view.location.origin,
      loadGltf,
      document,
      shouldMount: active,
      storage,
      grantStore: grantStoreFor(view),
    });
    if (!active()) {
      await mounted.unmount();
      return;
    }
    extensions = mounted;
    extensionUi = mountExtensionUi(mounted);
    view.__wowExtensions = {
      get summary() { return mounted.summary; },
      discovery: built.render_summary.extensions,
      unmount: () => mounted.unmount(),
    };
    const publishCounts = () => {
      if (!active()) return;
      document.body.setAttribute(
        "data-wow-extensions",
        JSON.stringify({
          mounted: mounted.mounted.length,
          refused: mounted.refused.length,
          failed: mounted.failed.length,
          not_started: mounted.not_started.length,
        })
      );
    };
    publishCounts();
    mounted.subscribe(publishCounts);
    logLine(
      `wow extensions: ${mounted.not_started.length} not started, ${mounted.refused.length} refused, ${mounted.failed.length} failed`
    );
    for (const record of [...mounted.refused, ...mounted.failed])
      logLine(
        `wow extension ${record.status} at ${record.stage}: ${record.label}#${record.index}: ${record.error}`
      );
    for (const pending of mounted.needs_consent)
      logLine(
        `wow extension ${pending.label}#${pending.index}: ${pending.tokens.join(", ")} ${pending.note}`
      );
  }
  // The glances, the panel of the selected extension (web/wow-extension-panel.mjs), the Extensions panel (opened from a
  // button in the world header, or at one extension from its panel's question mark) and pointer input on the canvas.
  function mountExtensionUi(mounted) {
    const undo = [];
    let openExtensionsPanel = null;
    if (document?.body && mounted.records.some((record) => record.selectable)) {
      const camera = built?.camera || null;
      const viewer = camera
        ? () => {
            camera.updateMatrixWorld();
            const at = camera.matrixWorld.elements;
            return [at[12], at[13], at[14]];
          }
        : null;
      const glances = renderGlanceList({ document, mounted, viewer });
      document.body.append(glances.element);
      undo.push(() => glances.dispose());
      const panelHost = renderPanelHost({ document, board: mounted.panels, onHelp: (key) => openExtensionsPanel?.(key) });
      document.body.append(panelHost.element);
      undo.push(() => panelHost.dispose());
    }
    const canvas = runtime?._impl?.renderer?.domElement;
    if (canvas && built?.camera) {
      const pointer = attachExtensionPointer({ THREE, camera: built.camera, scene: built.scene, canvas, mounted });
      undo.push(() => pointer.dispose());
    }
    const actions = document?.querySelector?.('[data-testid="header-actions"]');
    if (actions && mounted.records.length) {
      let panel = null;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "header-icon-button extensions-toggle";
      button.setAttribute("data-testid", "extensions-toggle");
      button.setAttribute("aria-expanded", "false");
      button.title = "Extensions in this world";
      button.setAttribute("aria-label", "Open the Extensions panel");
      button.innerHTML = '<svg class="header-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 4h6v4h4v6h-4v6H9v-6H5V8h4z"></path></svg>';
      const closePanel = () => {
        if (panel) panel.close();
      };
      openExtensionsPanel = (focus = null) => {
        if (panel) return focus ? panel.focus(focus) : undefined;
        panel = renderExtensionsPanel({
          document,
          mounted,
          focus,
          onClose: () => {
            panel = null;
            button.setAttribute("aria-expanded", "false");
          },
        });
        document.body.append(panel.element);
        button.setAttribute("aria-expanded", "true");
        return undefined;
      };
      button.addEventListener("click", () => (panel ? closePanel() : openExtensionsPanel()));
      actions.prepend(button);
      undo.push(() => {
        closePanel();
        button.remove();
      });
    }
    return { dispose: () => { for (const step of undo.splice(0).reverse()) step(); } };
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
      void loadModels()
        .then(loadExtensions)
        .catch((error) => {
          if (active()) logLine(`wow extensions ERROR: ${error?.message || error}`);
        });
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
    const mountedExtensions = extensions;
    extensions = null;
    extensionUi?.dispose();
    extensionUi = null;
    if (mountedExtensions) {
      void mountedExtensions.unmount();
      view.__wowExtensions = null;
    }
    for (const remove of removers.splice(0).reverse()) remove();
  }
  return { start, dispose, runtime: () => runtime };
}
