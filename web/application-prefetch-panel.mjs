import { fixed3, escapeHtml } from "./application-debug-format.mjs";
export function createApplicationPrefetchPanel(writer, documentTarget, reconcileHtml) {
  return { render(debug, facts) {
    const card = writer.element("fabric-prefetch-card"); if (!card) return null;
    const fp = debug ? debug.fabric_prefetch : null, totals = fp?.region?.totals;
    writer.attribute("data-fabric-prefetch-status", fp ? fp.status : "none");
    writer.attribute("data-fabric-prefetch-supported", fp && fp.supported ? "true" : "false");
    writer.attribute("data-fabric-prefetch-region-entities", totals && totals.region_entities != null ? String(totals.region_entities) : "");
    writer.attribute("data-fabric-prefetch-fabric-entities", totals && totals.fabric_entities != null ? String(totals.fabric_entities) : "");
    card.hidden = false;
    if (!fp || !fp.supported || !facts.isPlayer) {
      writer.text("fx-status", !facts.isPlayer ? "not active in observer view" : "not supported by this world");
      writer.text("fx-address", "—"); writer.text("fx-last-event", "waiting for a supported player destination"); return null;
    }
    writer.text("fx-status", fp.status); writer.text("fx-address", fp.address ? fp.address.uri : "—");
    zoneRows(writer, fp, facts); regionRows(writer, fp, facts); destinationRows(writer, fp, facts);
    presenceRows(writer, fp, facts); cacheRows(writer, fp, facts); portalList(writer, fp.keyed || null, documentTarget, reconcileHtml);
    const keyed = fp.keyed || null;
    const machines = keyed && keyed.machines && Object.keys(keyed.machines).length ? keyed.machines : { [fp.portal_key || "primary"]: fp };
    return { completion: fp.completion || null, machines: Object.values(machines).filter(machine => machine && machine.supported) };
  } };
}
function zoneRows(writer, fp, facts) {
  const zones = fp.zones || {};
  writer.text(
    "fx-zone",
    zones.prefetch
      ? `r=${fixed3(zones.prefetch.radius_m)} m · avatar ${fixed3(fp.zone && fp.zone.distance_m)} m · ${
          fp.zone && fp.zone.inside ? "INSIDE" : "outside"
        }`
      : "—"
  );
  writer.text(
    "fx-trigger",
    zones.traversal
      ? `oval ${fixed3(zones.traversal.width_m)}×${fixed3(zones.traversal.height_m)} m · depth ${fixed3(
          zones.traversal.trigger_depth_m
        )} m · commits traversal`
      : "—"
  );
}

function regionRows(writer, fp, facts) {
  const totals = fp.region ? fp.region.totals : null;
  const zones = fp.zones || {};
  const fxProgressive = fp.region ? fp.region.progressive : null;
  const fxStreaming = fp.region && fp.region.streaming ? fp.region.streaming : null;
  writer.text(
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
  writer.text(
    "fx-region-age",
    fp.region && fp.region.age_ms != null
      ? `${(fp.region.age_ms / 1000).toFixed(1)}s old · ttl ${(fp.region.ttl_ms / 1000).toFixed(0)}s`
      : "—"
  );
}

function destinationRows(writer, fp, facts) {
  const zones = fp.zones || {};
  const fxAvatars = fp.region ? fp.region.avatars : null;
  const fxMatch =
    zones.prefetch && zones.prefetch.matching_destination_circle
      ? zones.prefetch.matching_destination_circle
      : null;
  writer.text(
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

  const fxSpatial =
    facts.assembly && facts.portalDebug && fp.portal_key
      ? (facts.portalDebug.records || {})[fp.portal_key] || null
      : null;
  writer.text(
    "fx-aperture-render",
    fxSpatial && fxSpatial.active
      ? `spatial window · ${fxSpatial.entity_mesh_count} entities · ${fxSpatial.avatar_proxy_count} avatars · ${fxSpatial.render_target.width}×${fxSpatial.render_target.height}`
      : "inactive (falls back to labeled snapshot ladder)"
  );
}

function presenceRows(writer, fp, facts) {
  const occupancy = fp.presence ? fp.presence.occupancy : null;
  writer.text(
    "fx-occupancy",
    occupancy
      ? `${(occupancy.avatars || []).map((a) => a.display_name || a.avatar_id).join(", ") || "none"} · arrivals ${
          occupancy.arrival_count
        } · live ${occupancy.live_subscriber_count}`
      : "—"
  );
  writer.text(
    "fx-presence-age",
    fp.presence && fp.presence.age_ms != null
      ? `${(fp.presence.age_ms / 1000).toFixed(1)}s old · refreshes ${fp.presence.refresh_count}`
      : "—"
  );
  const lastEvent = Array.isArray(fp.events) && fp.events.length ? fp.events[fp.events.length - 1] : null;
  writer.text("fx-last-event", lastEvent ? `${lastEvent.event} @ ${lastEvent.at}` : "—");
}

function cacheRows(writer, fp, facts) {
  const fxCache = fp.keyed && fp.keyed.cache ? fp.keyed.cache : null;
  writer.text(
    "fx-cache",
    fxCache
      ? `${fxCache.total_bytes} of ${fxCache.cap_bytes} B cached · evictions ${fxCache.eviction_count}${
          fxCache.cap_source === "query_param_fixture" ? " · cap=fixture" : ""
        }`
      : "—"
  );
  const fxCompletion = fp.completion || null;
  writer.text(
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
}

function portalRow(key, keyed) {
  const machines = keyed.machines || {}, occupancyStore = keyed.destination_occupancy || null;
    const machine = machines[key];
    if (!machine) return "";
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
    return (
      `<div class="kv" data-reconcile-key="portal:${escapeHtml(key)}"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(machine.status)} · ${escapeHtml(dest)} · ${machine.zone && machine.zone.distance_m != null ? machine.zone.distance_m + " m" : "—"}${
        occCount != null ? ` · ${occCount} there` : ""
      }${marks ? ` · ${marks}` : ""}</span></div>`
    );
}

function portalListHtml(keyed) {
  const machines = keyed.machines || {};
  const lines = [];
  lines.push('<div class="std-sub" data-reconcile-key="portal-list-heading">portal choice — per-portal prefetch machines</div>');
  lines.push(
    `<div class="kv" data-reconcile-key="portal-list-budget"><span class="k">load budget</span><span class="v">${
      keyed.active_load_count
    }/${keyed.budget} active · max seen ${keyed.max_observed_active_loads}</span></div>`
  );
  for (const key of Object.keys(machines)) lines.push(portalRow(key, keyed));
  return lines.join("");
}

function portalList(writer, keyed, documentTarget, reconcileHtml) {
  const card = writer.element("fabric-prefetch-card");
  if (!card) return;
  let host = documentTarget.getElementById("fx-portal-list");
  const multi = keyed && keyed.portal_count > 1;
  documentTarget.body.setAttribute("data-fabric-prefetch-portal-count", keyed ? String(keyed.portal_count || 0) : "0");
  documentTarget.body.setAttribute(
    "data-fabric-prefetch-budget",
    keyed && keyed.budget != null ? String(keyed.budget) : ""
  );
  documentTarget.body.setAttribute(
    "data-fabric-prefetch-max-observed-active-loads",
    keyed && keyed.max_observed_active_loads != null ? String(keyed.max_observed_active_loads) : ""
  );
  if (!multi) {
    if (host) host.hidden = true;
    return;
  }
  if (!host) {
    host = documentTarget.createElement("div");
    host.id = "fx-portal-list";
    card.appendChild(host);
  }
  host.hidden = false;
  reconcileHtml(host, portalListHtml(keyed));
}
