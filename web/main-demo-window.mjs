/*
 * What a standard portal's window reads in place of a prefetch machine (web/portal-spatial-preview.mjs keeps the
 * window itself: the camera glue, the opening and the crossing takeover). The frame and the bounds come from the
 * destination's preview, the people from this browser's same-browser channel, and nothing comes from a prefetch.
 */

/** Nothing: the prefetch never feeds a standard portal's window. */
export const STANDARD_PORTAL_MACHINE = Object.freeze({ supported: true, standard_portal: true, region: null, presence: null, zones: null, zone: null });

/** What keeps two destinations apart: a standard portal's URL (its arrival included), else the demo's ids. */
export function destinationKeyOf(portalEntry, portalKeyOf) {
  if (portalEntry && portalEntry.wow_resource) return `standard|${portalEntry.wow_resource.destination || `nowhere:${portalKeyOf(portalEntry)}`}`;
  return [portalEntry?.target_location_id || "", portalEntry?.target_world_id || ""].join("|");
}

/** A standard portal as its window sees it: the frame and the bounds its destination's preview gives. */
export function windowEntryFrom(portalEntry, source) {
  const content = source && source.status === "ready" ? source.value : null;
  if (!content || !content.window_frame) return portalEntry;
  if (portalEntry.preview_awareness === content.awareness && portalEntry.target_frame === content.window_frame) return portalEntry;
  return { ...portalEntry, target_frame: content.window_frame, preview_awareness: content.awareness };
}

/** A portal with an active radius sleeps until the visitor comes within it, and loads its preview only then. */
export function portalAsleep(portalEntry, visitorAt) {
  const radius = Number(portalEntry && portalEntry.active_radius_m);
  if (!(radius > 0) || !portalEntry.frame || !Array.isArray(visitorAt)) return false;
  const frame = portalEntry.frame.position;
  return Math.hypot(Number(visitorAt[0]) - frame[0], Number(visitorAt[2]) - frame[2]) > radius;
}

/**
 * Inside a standard portal's preview: the players this browser already hears from (the same-browser channel) in that
 * world, and nothing fetched from it. The preview's radius bounds them, as it bounds every node.
 */
export function sameBrowserAvatars(peers, portalEntry, controlledId) {
  const controlled = String(controlledId || "");
  const here = portalEntry ? portalEntry.target_location_id : null;
  const avatars = Array.from(peers)
    .filter((peer) => peer.location_id === here && peer.player_id !== controlled)
    .map((peer) => ({ ...peer, authoritative_presence_position: peer.position.slice(0, 3), destination_circle_valid: true }));
  return {
    avatars,
    filter: { source: "same_browser_channel", controlled_player_id: controlled || null, rendered_player_ids: avatars.map((avatar) => avatar.player_id) },
  };
}

/** What each portal's window shows now, for its ring's state and for evidence. */
export function previewStatesOf(records) {
  const out = {};
  for (const [key, rec] of records) {
    const content = rec.destinationContent;
    out[key] = content && content.kind === "wow_bounded_preview"
      ? {
          kind: content.preview_kind,
          reason: content.reason,
          destination: content.destination,
          node_ids: (content.nodes || []).map((node) => node.id),
          closed_portals: rec.composition?.presentation?.closed_portals || [],
          // the destination's restricted objects, drawn as faint boxes
          restricted_ghosts: rec.composition?.presentation?.restricted_ghosts || [],
          radius_m: content.radius_m ?? null,
          status: rec.contentStatus,
          assets: rec.composition?.presentation?.assets || null,
          // the people drawn through the opening: only the same-browser channel may add one
          avatars_shown: rec.avatarRepresentations ? rec.avatarRepresentations.size : 0,
          // whether this window reads a prefetch machine: it never may
          prefetch_fed: !!rec.machine && !rec.machine.standard_portal,
        }
      : { kind: null, status: rec.contentStatus, reason: rec.contentError || null };
  }
  return out;
}
