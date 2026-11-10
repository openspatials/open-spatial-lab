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
    const report = readAdapter()?.getCapabilities();
    const features = Object.entries(report?.features || {});
    const limits = features.filter(([, value]) => value.status !== "supported").length;
    summary.textContent = `Renderer: ${report?.engine || "loading"}${limits ? ` · ${limits} limits` : ""}`;
    panel.replaceChildren();
    row("Renderer", `${report?.engine || "loading"} ${report?.version || ""} · requested ${rendererChoice?.requested || "default"}`);
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
