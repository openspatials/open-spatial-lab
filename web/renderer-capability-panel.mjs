// The source and importer of each layer of the Scene the adapter shows, by the layer's source format.
const SOURCES = Object.freeze({ "x3d-json": Object.freeze({ source: "X3D", importer: "X3D" }), gltf: Object.freeze({ source: "glTF", importer: "glTF" }) });

const shownLayers = (adapter) => {
  const scene = adapter?.attachedScene;
  if (!scene || typeof scene.layers !== "function") return [];
  return scene.layers().map((name) => scene.layer(name)).filter((layer) => layer.visible);
};

/** Each shown layer's importer and its capabilities, as the Scene Manager recorded them on the layer. */
export function sceneImporters(adapter) {
  return shownLayers(adapter).filter((layer) => layer.importer).map((layer) => ({ layer: layer.name,
    importer: SOURCES[layer.importer.format]?.importer ?? layer.importer.format, capabilities: Object.entries(layer.importer.capabilities ?? {}) }));
}

/** What the open file has that was not drawn: the importer's kept, skipped and refused lines, and the renderer's own list. */
export function notDrawn(adapter) {
  const items = [];
  for (const layer of shownLayers(adapter)) {
    const report = layer.report ?? {};
    for (const list of ["kept", "skipped", "refused"]) for (const item of report[list] ?? []) items.push({ by: "importer", list, path: item.path, reason: item.reason ?? "" });
  }
  for (const item of adapter?.sceneRoot?.userData?.notDrawn ?? []) items.push({ by: "renderer", list: "not drawn", path: item.key, reason: item.reason });
  return items;
}

/** The chain in use, e.g. "Source: X3D. Importer: X3D. Renderer: Three.js.", or null when the adapter shows no Scene. */
export function sceneChainLine(adapter, report) {
  const scene = adapter?.attachedScene;
  if (!scene || typeof scene.layers !== "function") return null;
  const renderer = String(report?.backend || "").startsWith("three") ? "Three.js" : report?.engine || "unknown";
  const layers = scene.layers().map((name) => scene.layer(name)).filter((layer) => layer.visible);
  if (!layers.length) return null;
  return layers.map((layer) => {
    const format = layer.source?.format, known = SOURCES[format];
    return `Source: ${known?.source ?? format ?? "unknown"}. Importer: ${known?.importer ?? "unknown"}. Renderer: ${renderer}.`;
  }).join(" ");
}

/** A projection of the active adapter and existing settings; owns no renderer policy. */
export function createRendererCapabilityPanel({ document, readAdapter, readAvatar, readRefresh, rendererChoice }) {
  const host = document.querySelector(".header-actions");
  if (!host) return { dispose() {}, refresh() {} };
  const details = document.createElement("details");
  details.className = "renderer-capabilities";
  const summary = document.createElement("summary");
  summary.id = "renderer-capability-summary";
  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "Renderer capabilities and settings");
  details.append(summary, panel);
  host.prepend(details);
  const row = (label, text) => {
    const item = document.createElement("p");
    const name = document.createElement("strong");
    name.textContent = `${label}: `;
    item.append(name, document.createTextNode(text));
    panel.append(item);
  };
  const refresh = () => {
    const adapter = readAdapter(), report = adapter?.getCapabilities();
    const features = Object.entries(report?.features || {}), importers = sceneImporters(adapter);
    const limits = features.filter(([, value]) => value.status !== "supported").length
      + importers.reduce((sum, { capabilities }) => sum + capabilities.filter(([, value]) => value.status !== "supported").length, 0);
    summary.textContent = `Renderer: ${report?.engine || "loading"}${limits ? ` · ${limits} limits` : ""}`;
    panel.replaceChildren();
    row("Renderer", `${report?.engine || "loading"} ${report?.version || ""} · requested ${rendererChoice?.requested || "default"}`);
    const chain = sceneChainLine(adapter, report);
    if (chain) {
      const line = document.createElement("p");
      line.id = "renderer-scene-chain";
      line.textContent = chain;
      panel.append(line);
    }
    for (const { importer, capabilities } of importers) {
      for (const [, feature] of capabilities) row(`Importer ${importer}`, `${feature.status} · ${feature.level} — ${feature.reason ?? feature.evidenceScope ?? ""}`);
    }
    if (importers.length) {
      const items = notDrawn(adapter), list = document.createElement("details");
      list.id = "renderer-not-drawn";
      const label = document.createElement("summary");
      label.textContent = `Not drawn from this file: ${items.length}`;
      list.append(label);
      for (const item of items) {
        const entry = document.createElement("p");
        entry.textContent = `${item.path} (${item.by}, ${item.list}): ${item.reason}`;
        list.append(entry);
      }
      panel.append(list);
    }
    if (rendererChoice?.fallback) row("Fallback", rendererChoice.message);
    const avatar = readAvatar();
    row("Avatar", avatar?.avatar_variant || "loading");
    row("Animation", "Shared avatar evaluator; completed joint and attachment poses are sampled once per frame.");
    row("Equipment", "Shared catalog · one held and one worn item use evaluated fitting. Extra items retain the legacy representation.");
    row("Known fit limits", "Shield penetration, concealed mug handles and some headwear fits remain under review.");
    const settings = readRefresh();
    row("Refresh", settings ? `${settings.mode} · client ${settings.client_interval_ms} ms · server ${settings.server_republish_ms || "off"}` : "Loading current settings");
    row("Motion", "Shared frame updates, capped at 50 ms; existing movement and camera smoothing.");
    for (const [name, feature] of features) row(name.replace(/([A-Z])/g, " $1"), `${feature.level} — ${feature.reason}${feature.limits?.length ? ` ${feature.limits.join("; ")}` : ""}`);
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.textContent = "Refresh settings";
    settingsButton.addEventListener("click", () => {
      details.open = false;
      document.getElementById("btn-refresh-settings")?.click();
    });
    panel.append(settingsButton);
  };
  details.addEventListener("toggle", refresh);
  refresh();
  return { refresh, dispose() { details.removeEventListener("toggle", refresh); details.remove(); } };
}
