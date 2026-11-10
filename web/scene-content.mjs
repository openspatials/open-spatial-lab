export function createSceneContentBuilder({
  THREE, buildWowScene, mountAirportTerminalContent, sceneDescription,
  getMount, document, motionPreference,
}) {
  return function buildContent(resolved, { world, source = resolved.source } = {}) {
    const host = getMount();
    const width = host?.clientWidth || 1100, height = host?.clientHeight || 660;
    const description = world === undefined ? { graph: resolved.graph } : { world, graph: resolved.graph };
    const built = buildWowScene(resolved.graph, THREE, {
      width, height, source, sceneDescription: sceneDescription(description),
    });
    const airportTerminal = mountAirportTerminalContent(resolved.graph, built, THREE, { document, motionPreference });
    const renderState = { frames: 0, error: null, renderer_kind: null, width, height };
    return { built, airportTerminal, renderState, width, height };
  };
}

export function createSceneAssetLoader({ THREE, mountWowSceneAssets, loadGltf, cloneScene, cache }) {
  return function loadAssets(built, { baseUrl, isCurrent, beforeMount, onAsset, onSettled, onError }) {
    const nodes = built.asset_nodes || [];
    const state = { status: nodes.length ? "pending" : "settled", requested: nodes.length, loaded: 0, failed: 0 };
    if (!nodes.length) return state;
    // Actor characters already belong to the avatar runtime; reuse its loaded instance.
    void mountWowSceneAssets(nodes, THREE, {
      loadGltf: (url, record) => built?.airport_entity_runtime?.runtimeActorScene?.(record) || loadGltf(url),
      cloneScene, cache, baseUrl, shouldMount: isCurrent, beforeMount,
      onAsset: (item, model, record) => {
        void built.airport_entity_runtime?.attachAsset(item, model, record);
        onAsset?.(item, model, record);
      },
    }).then(summary => {
      if (!isCurrent()) return;
      Object.assign(state, summary, { status: "settled" });
      onSettled?.(summary);
    }).catch(error => {
      Object.assign(state, { status: "error", error: error?.message || String(error) });
      onError?.(state.error);
    });
    return state;
  };
}

export function createHandoffAssetPacer(isCurrent, isHandoffInFlight, requestFrame) {
  let transferReadyPromise = null;
  return function beforeMount() {
    if (!transferReadyPromise) {
      transferReadyPromise = new Promise(resolve => {
        const waitForTransfer = () => {
          if (!isCurrent() || !isHandoffInFlight()) { resolve(); return; }
          requestFrame(waitForTransfer);
        };
        waitForTransfer();
      });
    }
    return transferReadyPromise.then(() => new Promise(resolve => requestFrame(() => resolve())));
  };
}
