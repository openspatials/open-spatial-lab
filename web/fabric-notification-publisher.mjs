function buildFabricEventRecord(fp, event, id, active) {
  const totals = fp.region && fp.region.totals ? fp.region.totals : null;
  const occupancy =
    fp.presence && fp.presence.occupancy ? fp.presence.occupancy : null;
  const destination = fp.address
    ? {
        location_id: fp.address.location_id,
        world_id: fp.address.world_id,
        fabric_id: fp.address.fabric_id,
        authority: fp.address.authority,
      }
    : null;
  return {
    id,
    kind: "fabric_prefetch_event",
    event_type: event.event,
    status: fp.status || "unknown",
    title: event.event.replace(/_/g, " "),
    summary: [
      fp.address ? fp.address.location_id : null,
      event.region_entities != null && event.fabric_entities != null
        ? `${event.region_entities}/${event.fabric_entities} entities`
        : null,
      event.occupancy_count != null ? `${event.occupancy_count} present` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    created_at: event.at || new Date().toISOString(),
    updated_at: event.at || new Date().toISOString(),
    source: {
      location_id: active ? active.location_id : null,
      world_id: active ? active.world_id : null,
      endpoint_key: active ? active.endpoint_key : null,
    },
    destination,
    prefetch: {
      status: fp.status,
      address: fp.address || null,
      zone: fp.zone || null,
      zones: fp.zones || null,
    },
    region: fp.region
      ? {
          loaded_at: fp.region.loaded_at || null,
          age_ms: fp.region.age_ms ?? null,
          totals,
        }
      : null,
    occupancy,
    claim_boundary: {
      application_level: true,
      roi_standard_conformance: false,
      standards_conformance: false,
    },
    raw_event: event,
  };
}

function fabricEventRecordId(event, index, portalKey) {
  const eventName = event && event.event ? String(event.event) : "fabric_event";
  const at = event && event.at ? String(event.at) : String(index);
  const scope = portalKey ? `-${portalKey}` : "";
  return `fabric-prefetch${scope}-${eventName}-${at}`.replace(
    /[^a-zA-Z0-9_.:-]+/g,
    "-"
  );
}

export function createFabricNotificationPublisher({
  getActive,
  publish: publishNotificationRecord,
}) {
  const publishedFabricEventKeys = new Set();
  let lastFabricCompletionRecordedFor = null;
  function publishFabricPrefetchNotifications(fp) {
    if (!fp || !fp.supported || !Array.isArray(fp.events)) return;
    for (let i = 0; i < fp.events.length; i += 1) {
      const event = fp.events[i];
      if (!event || !event.event) continue;
      const id = fabricEventRecordId(event, i, fp.portal_key || null);
      if (publishedFabricEventKeys.has(id)) continue;
      publishedFabricEventKeys.add(id);
      const record = buildFabricEventRecord(fp, event, id, getActive());
      publishNotificationRecord(record);
    }
  }
  function publishFabricCompletionNotification(completion) {
    if (!completion || !completion.reconciliation) return;
    const recordKey = `${completion.handoff_id || "no-handoff"}:${
      completion.status
    }`;
    if (lastFabricCompletionRecordedFor === recordKey) return;
    if (
      completion.status !== "complete" &&
      completion.status !== "complete_with_mismatch"
    )
      return;
    lastFabricCompletionRecordedFor = recordKey;
    publishNotificationRecord({
      id: `fabric-completion-${completion.handoff_id || "no-handoff"}`,
      kind: "fabric_completion",
      event_type: "fabric_completion_reconciled",
      status: completion.status,
      title: "background fabric completion",
      summary:
        `${completion.location_id} · +${completion.entities_added} entities in background · ` +
        `${completion.reconciliation.received_unique_entities}/${completion.reconciliation.expected_fabric_entities} ` +
        `${completion.reconciliation.match ? "reconciled" : "MISMATCH"} · ` +
        `${completion.reconciliation.duration_ms} ms · input during completion: ` +
        `${completion.reconciliation.input_during_completion.movement_samples} movement samples`,
      created_at: completion.started_at,
      updated_at: completion.completed_at || new Date().toISOString(),
      destination: {
        location_id: completion.location_id,
        fabric_id: completion.fabric_id,
      },
      completion: {
        status: completion.status,
        pacing_ms: completion.pacing_ms,
        chunk_count: completion.chunk_count,
        entities_added: completion.entities_added,
        reconciliation: completion.reconciliation,
        origin_prefetch: completion.origin_prefetch,
      },
      claim_boundary: {
        application_level: true,
        roi_standard_conformance: false,
        standards_conformance: false,
      },
    });
  }
  return {
    publishFabricPrefetchNotifications,
    publishFabricCompletionNotification,
  };
}
