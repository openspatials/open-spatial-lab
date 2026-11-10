const AIRPORT_LOCATION_ID = "location-airport";
const AIRPORT_SPATIAL_ID = "world-airport-terminal";

export function createSceneMetadata(document) {
  function publishTerminalReadyWorld(spatialId) {
    if (!spatialId) {
      document.body.removeAttribute("data-terminal-ready-world");
      document.body.removeAttribute("data-airport-terminal-ready");
      return;
    }
    const mountedWorldId = String(spatialId || "");
    document.body.setAttribute("data-terminal-ready-world", mountedWorldId);
    if (mountedWorldId === AIRPORT_SPATIAL_ID) document.body.setAttribute("data-airport-terminal-ready", "1");
    else document.body.removeAttribute("data-airport-terminal-ready");
  }
  function publishAuthoredSceneWorld(world, resolved) {
    document.body.setAttribute("data-authored-scene-world", String(resolved?.spatialID || world?.world_id || ""));
    if (world?.location_id === AIRPORT_LOCATION_ID && resolved?.spatialID === AIRPORT_SPATIAL_ID)
      document.body.setAttribute("data-airport-backend-scene", "1");
    else document.body.removeAttribute("data-airport-backend-scene");
  }
  function publishAssetCounts({ loaded, failed }) {
    document.body.setAttribute("data-wow-assets-loaded", String(loaded));
    document.body.setAttribute("data-wow-assets-failed", String(failed));
  }
  function resetAssets(nodes) {
    document.body.setAttribute("data-wow-asset-nodes", String(nodes.length));
    publishAssetCounts({ loaded: 0, failed: 0 });
  }
  function clearAssets() {
    document.body.removeAttribute("data-wow-asset-nodes");
    document.body.removeAttribute("data-wow-assets-loaded");
    document.body.removeAttribute("data-wow-assets-failed");
  }
  function publishHeader({ title, meta, backend, color }) {
    const titleElement = document.getElementById("loc-title");
    const metaElement = document.getElementById("loc-meta");
    const backendElement = document.getElementById("live-backend");
    if (titleElement) titleElement.textContent = title;
    if (metaElement) metaElement.textContent = meta;
    if (backendElement) { backendElement.textContent = backend; backendElement.style.color = color; }
  }
  function publishWorldHeader(world, backend) {
    publishHeader({ title: world.title, meta: `${world.location_id} · ${world.world_id} · ${world.session_id}`, backend, color: "var(--ok)" });
  }
  function publishClientHeader(target, contract, resolved) {
    publishHeader({ title: resolved.graph.title || "Denver Skyport",
      meta: `${contract.spatial_id} · client scene load · same player session`,
      backend: `${target.graph_endpoint} (local-data-backed scene; no backend handoff)`, color: "var(--muted, #9aa)" });
  }
  return Object.freeze({ publishTerminalReadyWorld, publishAuthoredSceneWorld, publishAssetCounts,
    resetAssets, clearAssets, publishWorldHeader, publishClientHeader });
}
