// Loading-content-through-the-portal (portaling bar P11),
// re-presented.
//
// The DESTINATION's loading experience used to render as a CENTER-SCREEN card
// in the source while the crossing's real background steps ran. The user
// mandate for portal traversal is now explicit: NOTHING mid-screen, ever — no
// modal, no card, no black status surface. therefore
// REMOVED the center-screen card render path entirely and converted the same
// content into:
//   1. a small transient TOAST (top strip, pointer-events:none, auto-dismiss)
//      fired only while a crossing is still in flight, plus destination
//      branding folded into the existing ARRIVED toast (app.js renderOverlay);
//   2. a structured NOTIFICATION-DETAIL RECORD (notification-center-compatible;
//      the notification center consumes exactly these
//      records) carrying the full background-step check-mark trail with
//      timestamps, destination branding/pointers, consent, the destination-
//      declared ETA, transfer duration, and honesty flags.
// The background-step model (real crossing signals only), the
// metaverse.portal.* content sourcing, and the manifest LoadingPointer binding
// are UNCHANGED. Nothing here delays or gates the crossing (it never did) —
// and the presentational minimum-visible hold the card used to have is gone
// with the card. The tracker's only timers stop TRACKING; they never hold any
// UI on screen.
//
// WHERE THE CONTENT COMES FROM (nothing hardcoded client-side):
//   - Each world server hosts its OWN loading content under the agreed
//     `metaverse.portal.*` pointer names (TeleportVR/UM integration packet):
//       metaverse.portal.loadingScreen / .loadingBranding / .loadingInstructions /
//       .estimatedLoadTime  + consent key metaverse.portal.preloadContent.
//     They ride the demo extension `GET /demo/portal-view` (and the
//     attach-point payload) as a `metaverse_portal` block — this module only
//     READS that block (from the reload cache, or one best-effort fetch).
//   - At crossing time the same pointers are bound into the emitted v0.4 UM
//     manifest through LoadingPointer interface (interfaces.mjs), the
//     same seam the IWPS destination-URL loading pointer already uses — so the
//     loading content is genuinely "carried in the manifest".
//
// HONESTY / CLAIM BOUNDARY (read before quoting):
//   DEMONSTRATION-ONLY. P11 is an interface requirement (MANDATE-portal-loading-content),
//   NOT a use-case-page conformance bar. The `metaverse.portal.*` names are
//   SUGGESTED pointer names from the TeleportVR/UM integration packet — not a
//   published UM/IWPS/WoW spec surface. This module flips NO conformance flag;
//   `um_conformance` is untouched. The emitted pointers are v0.4 pointer-SHAPED
//'s structural contract only.
//
// Zero import-time side effects and no DOM access at import (Node-importable,
// like interfaces.mjs), so it can be smoke-tested headlessly.

import { makeLoadingPointer, validateLoadingPointer } from "./manifest/interfaces.mjs";

// The agreed pointer names (TeleportVR/UM integration packet §pointers).
export const METAVERSE_PORTAL_POINTER_NAMES = Object.freeze([
  "metaverse.portal.loadingScreen",
  "metaverse.portal.loadingBranding",
  "metaverse.portal.loadingInstructions",
  "metaverse.portal.estimatedLoadTime",
]);
export const METAVERSE_PORTAL_CONSENT_KEY = "metaverse.portal.preloadContent";

// The scoped honesty descriptor for this capability (mirrors the style).
export const PORTAL_LOADING_DEMO = Object.freeze({
  version_id: "runtime",
  capability: "loading-content-through-the-portal (portaling bar P11)",
  demonstration_only: true,
  presentation:
    "toast + notification-detail record; the original center-screen " +
    "loading card is REMOVED per interface requirement — no mid-screen surface during traversal",
  source_of_content:
    "metaverse.portal.* pointers served by the DESTINATION world server (runtime GET /demo/portal-view demo extension); not hardcoded client-side",
  manifest_binding:
    "bound into the emitted v0.4 UM manifest as runtime LoadingPointers (structural v0.4 pointer shape only)",
  standards_conformance: false,
  um_conformance_claim: false,
  scope_note:
    "interface requirement (MANDATE-portal-loading-content) + explainer Scene 3b; pointer names are " +
    "SUGGESTIONS from the TeleportVR/UM integration packet, not a published spec surface. " +
    "No conformance flag is flipped by this capability.",
});

// ---------------------------------------------------------------------------
// Pure helpers (no DOM) — extraction + manifest-pointer binding.
// ---------------------------------------------------------------------------

/**
 * Pull the destination's `metaverse_portal` loading-content block out of a
 * payload (GET /demo/portal-view or GET /demo/um/attach-point JSON).
 * Returns null when the payload does not carry one (older server). Never throws.
 */
export function extractPortalLoadingContent(payload) {
  try {
    const block = payload && typeof payload === "object" ? payload.metaverse_portal : null;
    if (!block || typeof block !== "object" || !block.pointers || typeof block.pointers !== "object") {
      return null;
    }
    return block;
  } catch (e) {
    return null;
  }
}

/**
 * Bind the destination's metaverse.portal.* content to LoadingPointers so
 * the emitted v0.4 manifest CARRIES the loading content (the acceptance
 * "sourced from metaverse.portal.* pointers"). Each pointer:
 *   label  = the metaverse.portal.* pointer NAME (+ honesty note),
 *   target = the destination-hosted resource URL that serves the content
 *            (IWPS downloadUrl-style reference resolved against the destination base),
 *   pointerId = `<name>.<handoffId>` (URN-normalized by the emitter).
 * Returns [] when content is absent. Never throws.
 */
export function buildLoadingPointersForManifest(content, opts) {
  const out = [];
  try {
    const block = extractPortalLoadingContent({ metaverse_portal: content }) || extractPortalLoadingContent(content);
    if (!block) return out;
    const o = opts && typeof opts === "object" ? opts : {};
    const handoffId = o.handoffId != null ? String(o.handoffId) : "crossing";
    const base = o.destinationBase != null ? String(o.destinationBase).replace(/\/+$/, "") : "";
    for (const name of METAVERSE_PORTAL_POINTER_NAMES) {
      const entry = block.pointers[name];
      if (!entry || typeof entry !== "object") continue;
      const href = typeof entry.href === "string" && entry.href.length > 0 ? entry.href : null;
      const ptr = makeLoadingPointer({
        target: href ? (base && href.startsWith("/") ? `${base}${href}` : href) : null,
        pointerId: `${name}.${handoffId}`,
        label: `${name} (destination loading content; demonstration-only)`,
      });
      if (validateLoadingPointer(ptr).valid) out.push(ptr);
    }
  } catch (e) {
    /* never block a manifest emit over loading-content binding */
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scene-3b step model — REAL background signals only (nothing simulated).
// Each step reads the live adapter debugState(); a step check-marks the moment
// the underlying mechanism actually reports done. The steps now check-mark
// INSIDE the notification record instead of on a card.
// ---------------------------------------------------------------------------
const STEPS = Object.freeze([
  {
    id: "exit-intent",
    label: "exit-intent accepted by source server",
    done: (dbg) =>
      !!(
        dbg &&
        dbg.crossing &&
        dbg.crossing.server_notifications &&
        dbg.crossing.server_notifications.exit_intent &&
        dbg.crossing.server_notifications.exit_intent.accepted
      ),
  },
  {
    id: "manifest-signed",
    label: "v0.4 UM manifest signed on exit (Profile A)",
    done: (dbg) => !!(dbg && dbg.um_signing && dbg.um_signing.signed_on_exit && dbg.um_signing.signed_on_exit.signed),
  },
  {
    id: "preload-consent",
    label: `preload consent — ${METAVERSE_PORTAL_CONSENT_KEY} (demo)`,
    done: (dbg, capture) => !!(capture && capture.content && capture.content.consent && capture.content.consent.granted),
  },
  {
    id: "arrival-accepted",
    label: "arrival accepted by destination server",
    done: (dbg) =>
      !!(
        dbg &&
        dbg.crossing &&
        dbg.crossing.server_notifications &&
        dbg.crossing.server_notifications.arrival &&
        dbg.crossing.server_notifications.arrival.accepted
      ),
  },
  {
    id: "manifest-verified",
    label: "manifest signature verified on arrival",
    done: (dbg) =>
      !!(
        (dbg && dbg.um_signing && dbg.um_signing.verified_on_arrival && dbg.um_signing.verified_on_arrival.verified === true) ||
        (dbg && dbg.crossing && dbg.crossing.um_manifest_verification && dbg.crossing.um_manifest_verification.verified === true)
      ),
  },
  {
    id: "fabric-promoted",
    label: "destination fabric promoted to root (same context)",
    done: (dbg) => {
      const hist = dbg && dbg.crossing && Array.isArray(dbg.crossing.phase_history) ? dbg.crossing.phase_history : [];
      return hist.includes("fabric_promoted_to_root") || hist.includes("destination_arrived");
    },
  },
  {
    id: "avatar-loaded",
    label: "avatar + equipment loaded in destination",
    done: (dbg) => {
      const hist = dbg && dbg.crossing && Array.isArray(dbg.crossing.phase_history) ? dbg.crossing.phase_history : [];
      return hist.includes("destination_arrived") && !!(dbg && dbg.avatar) && !!(dbg && dbg.equipment_status);
    },
  },
]);

// Tracking timers — these STOP THE TRACKER only; no UI is ever held on screen
// (the old card's minimum-visible hold is deliberately gone with the card).
// Hard ceiling so a record can never track forever (e.g. a signal that never
// flips); grace before finalizing an unwound crossing (RP1 fail-closed deny /
// exit-intent failure fail-open path).
const MAX_TRACK_MS = 12000;
const UNWOUND_END_MS = 1200;
const REFRESH_MS = 200;

// ---------------------------------------------------------------------------
// Tracker state (module-scoped; one player window = one tracker).
// ---------------------------------------------------------------------------
const tracker = {
  configured: false,
  isPlayer: false,
  adapter: null,
  readCachedLoadingContent: null, // (endpointKey) => metaverse_portal block | null
  fetchLoadingContent: null, // async (endpointKey) => metaverse_portal block | null
  logLine: null,
  showToast: null, // (big, sub, cls, opts) => void — app.js transient toast stack
  publishNotification: null, // (record) => void — app.js notification shell
  active: false, // a crossing's background steps are being tracked
  startedAt: 0,
  refreshTimer: null,
  crossingKey: null, // handoff id (or "pending") the tracker is following
  lastCompletedKey: null, // last handoff id we already tracked
  capture: null, // { key, base, content } — destination snapshot taken at start
  record: null, // the LIVE notification record being updated in place
  lastStatusLine: "—",
  sessionsCount: 0,
  toastsShown: 0,
};

function $id(id) {
  return typeof document !== "undefined" ? document.getElementById(id) : null;
}

/**
 * Resolve which world endpoint ("a" | "b") the crossing is loading INTO, at
 * tracking-start time. Priority: the portal's own target_location_id (server
 * truth the adapter mirrors into controls), then the live crossing record's
 * `to` location, then the player's pre-promotion preview key (the destination
 * before the fabric promotion flips the keys).
 */
function resolveDestinationKey(dbg, adapter) {
  const fromLocation = (loc) => {
    const m = /^location-([ab])$/.exec(String(loc || ""));
    return m ? m[1] : null;
  };
  const targetLoc = dbg && dbg.controls ? dbg.controls.portal_target_location_id : null;
  const fromControls = fromLocation(targetLoc);
  if (fromControls) return fromControls;
  const liveCrossing = dbg && dbg.crossing && !dbg.crossing.completed_at ? dbg.crossing : null;
  const fromCrossing = liveCrossing && liveCrossing.to ? fromLocation(liveCrossing.to.location_id) : null;
  if (fromCrossing) return fromCrossing;
  if (adapter && adapter.previewEndpointKey) return adapter.previewEndpointKey;
  return adapter && adapter.activeEndpointKey === "a" ? "b" : "a";
}

/** One-time wiring from app.js (player window only does anything visible). */
export function initPortalLoadingOverlay(opts) {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    tracker.configured = true;
    tracker.isPlayer = !!o.isPlayer;
    tracker.adapter = o.adapter || null;
    tracker.readCachedLoadingContent =
      typeof o.readCachedLoadingContent === "function" ? o.readCachedLoadingContent : null;
    tracker.fetchLoadingContent = typeof o.fetchLoadingContent === "function" ? o.fetchLoadingContent : null;
    tracker.logLine = typeof o.logLine === "function" ? o.logLine : null;
    tracker.showToast = typeof o.showToast === "function" ? o.showToast : null;
    tracker.publishNotification = typeof o.publishNotification === "function" ? o.publishNotification : null;
    setPanelLine(
      tracker.isPlayer
        ? "armed — next crossing tracks as toast + notification record (destination metaverse.portal.* pointers; no center-screen card; demonstration-only)"
        : "player-window capability (observers mirror the crossing untouched)"
    );
    setBodyLoadingAttr(tracker.isPlayer ? "armed" : "observer");
  } catch (e) {
    /* init must never break the demo */
  }
}

/**
 * Per-state hook (called from app.js onState). Detects crossing start/end and
 * drives the toast + notification record. Never throws.
 */
// A crossing record counts as "this tracker's crossing" only if it STARTED
// recently (the adapter keeps the previous, long-completed record around —
// e.g. the forward record is still present when the return walk-through begins).
const RECENT_CROSSING_MS = 4000;
function crossingStartedAfter(rec, sinceEpochMs) {
  const t = rec && rec.started_at ? Date.parse(rec.started_at) : NaN;
  return Number.isFinite(t) && t >= sinceEpochMs;
}

export function notePortalLoadingState(dbg) {
  try {
    if (!tracker.configured || !tracker.isPlayer || !dbg) return;
    const transitionActive =
      dbg.controls && dbg.controls.portal_transition_phase && dbg.controls.portal_transition_phase !== "none";
    const rawCrossing = dbg.crossing || null;
    const liveCrossing = rawCrossing && !rawCrossing.completed_at ? rawCrossing : null;
    // The demo's composition crossing can COMPLETE between two state events, so a
    // freshly-completed record (started within the last few seconds) still counts
    // as the crossing to track — a stale record from an earlier leg never does.
    const recentCrossing =
      liveCrossing ||
      (rawCrossing && crossingStartedAfter(rawCrossing, Date.now() - RECENT_CROSSING_MS) ? rawCrossing : null);
    // Key priority: an ACTIVE walk-through always means a NEW crossing is starting
    // ("pending", adopted once the commit assigns the id) — only a quiescent state
    // falls back to the live/recent record's id.
    const key = transitionActive
      ? (liveCrossing && liveCrossing.handoff_id) || "pending"
      : (recentCrossing && recentCrossing.handoff_id) || null;

    if (!tracker.active) {
      // A NEW crossing is starting (walk-through began / commit in flight / just
      // committed), and it is not the crossing we already tracked.
      if ((transitionActive || recentCrossing) && key !== null && key !== tracker.lastCompletedKey) {
        beginTracking(dbg, key, { inFlight: !!(transitionActive || liveCrossing) });
      }
      return;
    }
    // Tracking: adopt the real handoff id once the commit assigns one — only from
    // a record that started around this tracker's start time (never the stale one).
    if (
      tracker.crossingKey === "pending" &&
      rawCrossing &&
      rawCrossing.handoff_id &&
      crossingStartedAfter(rawCrossing, tracker.startedAt - 2000)
    ) {
      tracker.crossingKey = rawCrossing.handoff_id;
      if (tracker.record) tracker.record.crossing.handoff_id = rawCrossing.handoff_id;
    }
    refreshTracking(dbg);
  } catch (e) {
    /* tracking the loading record must never break the crossing */
  }
}

// ---------------------------------------------------------------------------
// Tracking lifecycle (replaces the old card show/refresh/hide lifecycle).
// ---------------------------------------------------------------------------
function beginTracking(dbg, key, opts) {
  tracker.active = true;
  tracker.startedAt = Date.now();
  tracker.crossingKey = key;
  tracker.sessionsCount += 1;

  // Snapshot the DESTINATION now. Server truth first: the portal's own
  // target_location_id (mirrored into controls by _updatePortalStatus), then the
  // live crossing record's `to` endpoint, then the pre-promotion preview key.
  // (Capture-at-start matters: after the fabric promotion the keys flip.)
  const adapter = tracker.adapter;
  const destKey = resolveDestinationKey(dbg, adapter);
  const base =
    adapter && typeof adapter.demoProxyBase === "function" ? adapter.demoProxyBase(destKey) : "";
  const cached = tracker.readCachedLoadingContent ? tracker.readCachedLoadingContent(destKey) : null;
  tracker.capture = { key: destKey, base, content: cached || null };

  tracker.record = buildNotificationRecord(dbg, destKey, base, key);
  if (tracker.publishNotification) tracker.publishNotification(tracker.record);
  setBodyLoadingAttr("tracking");

  // The small traversal toast — ONLY while the crossing is still in flight at
  // detection time. A post-commit detection (the instant local crossing often
  // completes between two state polls) must NOT fire it: renderOverlay's
  // ARRIVED toast carries the transfer-duration headline in that same
  // tick and would be stomped. The notification record is the deterministic
  // carrier either way; the ARRIVED toast also carries destination branding.
  if (opts && opts.inFlight && tracker.showToast) {
    const screen = contentValue("metaverse.portal.loadingScreen") || {};
    const brand = contentValue("metaverse.portal.loadingBranding") || {};
    const title = escapeToastText(
      screen.headline || (brand.world_title ? `Entering ${brand.world_title}` : "Entering destination…")
    );
    const sub = escapeToastText(
      [brand.tagline || null, `${STEPS.length} background steps tracking`, "demonstration-only"]
        .filter(Boolean)
        .join(" · ")
    );
    tracker.showToast(title, sub, "toast-departed", { notificationId: tracker.record.id });
    tracker.toastsShown += 1;
    tracker.record.toast.shown = true;
    tracker.record.toast.shown_at = new Date().toISOString();
  }

  if (!tracker.capture.content && tracker.fetchLoadingContent) {
    // One best-effort lazy fetch (the reload cache is normally warm).
    // Updates the RECORD (the detail carrier); an already-fired toast is not
    // retro-edited.
    Promise.resolve(tracker.fetchLoadingContent(destKey))
      .then((content) => {
        if (tracker.capture && tracker.capture.key === destKey && content) {
          tracker.capture.content = content;
          if (tracker.record) applyContentToRecord(tracker.record);
        }
      })
      .catch(() => {});
  }

  if (tracker.logLine) {
    tracker.logLine(
      `runtime: through-portal loading record OPEN (toast+notification; no center-screen card — runtime) — ` +
        `content from ${destKey.toUpperCase()} metaverse.portal.* pointers${tracker.capture.content ? "" : " (fetching…)"}; demonstration-only`
    );
  }
  if (tracker.refreshTimer) clearInterval(tracker.refreshTimer);
  tracker.refreshTimer = setInterval(() => {
    try {
      const live = tracker.adapter && typeof tracker.adapter.debugState === "function" ? tracker.adapter.debugState() : null;
      if (live) refreshTracking(live);
    } catch (e) {
      /* keep ticking */
    }
  }, REFRESH_MS);
  refreshTracking(dbg);
}

function refreshTracking(dbg) {
  if (!tracker.active || !tracker.record) return;
  const rec = tracker.record;
  const now = Date.now();
  const elapsedMs = now - tracker.startedAt;
  const crossing = dbg.crossing || null;
  const relevant = crossing && tracker.crossingKey && crossing.handoff_id === tracker.crossingKey ? crossing : null;
  const transitionActive =
    dbg.controls && dbg.controls.portal_transition_phase && dbg.controls.portal_transition_phase !== "none";

  // Steps read THIS tracker's crossing record only — never a stale completed one
  // (the adapter keeps the previous record around, e.g. during the return leg).
  const stepCrossing = relevant || (crossing && !crossing.completed_at ? crossing : null);
  const stepDbg = stepCrossing === crossing ? dbg : { ...dbg, crossing: stepCrossing };

  let doneCount = 0;
  for (let i = 0; i < STEPS.length; i += 1) {
    const step = STEPS[i];
    const entry = rec.steps[i];
    if (!entry.done && step.done(stepDbg, tracker.capture)) {
      entry.done = true;
      entry.done_at = new Date().toISOString();
    }
    if (entry.done) doneCount += 1;
  }

  const declared = declaredEtaMs();
  rec.eta.destination_declared_ms = declared;
  rec.summary =
    `${doneCount}/${STEPS.length} background steps · elapsed ${(elapsedMs / 1000).toFixed(1)}s` +
    (declared != null ? ` · destination-declared estimate ${(declared / 1000).toFixed(1)}s` : "");
  rec.updated_at = new Date().toISOString();

  const completed = !!(relevant && relevant.completed_at);
  if (completed) {
    rec.crossing.completed_at = relevant.completed_at;
    const resumeMs = Number(relevant.controls_resume_ms);
    if (Number.isFinite(resumeMs)) rec.transfer.controls_resume_ms = resumeMs;
  }
  // Unwound = the walk-through ended without a NEW crossing record ever being
  // created (RP1 fail-closed deny / exit-intent failure). A stale completed
  // record from an earlier crossing does not count as progress.
  const unwound = !transitionActive && !stepCrossing && tracker.crossingKey === "pending";
  setPanelLine(panelLineFor(doneCount, completed));

  if (completed && doneCount >= STEPS.length) {
    endTracking("complete", doneCount);
  } else if (unwound && elapsedMs >= UNWOUND_END_MS) {
    endTracking("unwound", doneCount);
  } else if (elapsedMs >= MAX_TRACK_MS) {
    // Ceiling: the record finalizes honestly with however many steps flipped
    // (a completed crossing with one lagging signal still reads "complete";
    // anything else is a timeout). Never holds any UI either way.
    endTracking(completed ? "complete" : "timeout", doneCount);
  }
}

function endTracking(status, doneCount) {
  const rec = tracker.record;
  tracker.active = false;
  // Whatever the end reason, this tracker's crossing is DONE — retire its id so
  // the (still-present, still-"recent") record can never re-trigger tracking.
  if (tracker.crossingKey && tracker.crossingKey !== "pending") {
    tracker.lastCompletedKey = tracker.crossingKey;
  }
  tracker.crossingKey = null;
  if (tracker.refreshTimer) {
    clearInterval(tracker.refreshTimer);
    tracker.refreshTimer = null;
  }
  if (rec) {
    rec.status = status;
    rec.completed_at = new Date().toISOString();
    rec.updated_at = rec.completed_at;
  }
  setBodyLoadingAttr(status);
  if (tracker.logLine) {
    tracker.logLine(
      `runtime: through-portal loading record ${String(status).toUpperCase()} ` +
        `(${doneCount}/${STEPS.length} steps) — detail in the notification record; no center-screen card`
    );
  }
}

// ---------------------------------------------------------------------------
// Notification record (the notification-center seam).
// ---------------------------------------------------------------------------
function buildNotificationRecord(dbg, destKey, base, key) {
  const nowIso = new Date().toISOString();
  const rec = {
    id: `runtime-loading-${tracker.sessionsCount}`,
    kind: "portal_through_loading",
    version_id: "runtime",
    presentation: "toast+notification (center-screen card removed by runtime)",
    severity: "info",
    created_at: nowIso,
    updated_at: nowIso,
    completed_at: null,
    status: "in_progress",
    title: "Entering destination…",
    summary: `0/${STEPS.length} background steps`,
    source: {
      endpoint_key: tracker.adapter ? tracker.adapter.activeEndpointKey || null : null,
      location_id: dbg && dbg.location_id ? dbg.location_id : null,
    },
    destination: {
      endpoint_key: destKey,
      location_id: `location-${destKey}`,
      world_title: null,
      tagline: null,
      instructions: null,
      base: base || null,
    },
    crossing: {
      handoff_id: key && key !== "pending" ? key : null,
      started_at: dbg && dbg.crossing && dbg.crossing.started_at ? dbg.crossing.started_at : null,
      completed_at: null,
    },
    transfer: { controls_resume_ms: null },
    steps: STEPS.map((s) => ({ id: s.id, label: s.label, done: false, done_at: null })),
    eta: { destination_declared_ms: null },
    pointers: {
      names_present: [],
      consent_key: METAVERSE_PORTAL_CONSENT_KEY,
      consent_granted: false,
    },
    toast: { shown: false, shown_at: null },
    honesty: {
      demonstration_only: true,
      standards_conformance: false,
      um_conformance_claim: false,
      center_screen_card: "removed",
    },
  };
  applyContentToRecord(rec);
  return rec;
}

/** Fold the captured destination metaverse.portal.* content into the record. */
function applyContentToRecord(rec) {
  const c = tracker.capture ? tracker.capture.content : null;
  const screen = contentValue("metaverse.portal.loadingScreen") || {};
  const brand = contentValue("metaverse.portal.loadingBranding") || {};
  const instr = contentValue("metaverse.portal.loadingInstructions") || {};
  rec.title = c
    ? String(screen.headline || (brand.world_title ? `Entering ${brand.world_title}` : "Entering destination…"))
    : "Entering destination…";
  rec.destination.world_title = brand.world_title ? String(brand.world_title) : rec.destination.world_title;
  rec.destination.tagline = brand.tagline ? String(brand.tagline) : rec.destination.tagline;
  rec.destination.location_id = brand.location_id ? String(brand.location_id) : rec.destination.location_id;
  rec.destination.instructions = Array.isArray(instr.instructions) ? instr.instructions.slice() : rec.destination.instructions;
  rec.eta.destination_declared_ms = declaredEtaMs();
  rec.pointers.names_present = c && c.pointers ? METAVERSE_PORTAL_POINTER_NAMES.filter((n) => c.pointers[n]) : [];
  rec.pointers.consent_granted = !!(c && c.consent && c.consent.granted);
  rec.updated_at = new Date().toISOString();
}

function contentValue(name) {
  const c = tracker.capture && tracker.capture.content;
  const entry = c && c.pointers ? c.pointers[name] : null;
  return entry && typeof entry === "object" ? entry.value || null : null;
}

function declaredEtaMs() {
  const v = contentValue("metaverse.portal.estimatedLoadTime");
  const ms = v && Number(v.estimated_load_ms);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function panelLineFor(doneCount, completed) {
  const c = tracker.capture && tracker.capture.content;
  const names = c && c.pointers ? METAVERSE_PORTAL_POINTER_NAMES.filter((n) => c.pointers[n]) : [];
  const consent = c && c.consent && c.consent.granted;
  const line =
    (tracker.active
      ? `tracking (${doneCount}/${STEPS.length} steps)`
      : completed
        ? "last crossing complete"
        : "armed") +
    ` · ${names.length} metaverse.portal.* pointers from ${tracker.capture ? tracker.capture.key.toUpperCase() : "?"}` +
    (consent ? ` · ${METAVERSE_PORTAL_CONSENT_KEY} granted (demo)` : "") +
    " · toast+notification (no center-screen card) · demonstration-only";
  tracker.lastStatusLine = line;
  return line;
}

function setPanelLine(text) {
  tracker.lastStatusLine = text;
  const el = $id("std-um-loading");
  if (el) el.textContent = text;
}

/** Mirror the tracking state on <body> for the headless driver / debugging. */
function setBodyLoadingAttr(value) {
  if (typeof document !== "undefined" && document.body) {
    document.body.setAttribute("data-runtime-loading", String(value));
  }
}

/**
 * Toast strings interpolate into the toast stack's innerHTML (app.js
 * showToast) and this lane's values are DESTINATION-SERVER-served — strip
 * markup-significant characters so hosted content can't inject markup.
 */
function escapeToastText(v) {
  return String(v).replace(/[<>&"]/g, "");
}

// ---------------------------------------------------------------------------
// Probe surface for the headless driver / manual verification.
// ---------------------------------------------------------------------------
export function portalLoadingDriverApi() {
  return {
    descriptor: () => ({ ...PORTAL_LOADING_DEMO }),
    status: () => ({
      configured: tracker.configured,
      is_player: tracker.isPlayer,
      // the center-screen card render path is REMOVED —
      // there is no card to be visible. Presentation is toast + record only.
      card_removed: true,
      presentation: "toast+notification-record",
      tracking_active: tracker.active,
      sessions_count: tracker.sessionsCount,
      toasts_shown: tracker.toastsShown,
      crossing_key: tracker.crossingKey,
      destination_key: tracker.capture ? tracker.capture.key : null,
      destination_content_present: !!(tracker.capture && tracker.capture.content),
      pointer_names_present:
        tracker.capture && tracker.capture.content && tracker.capture.content.pointers
          ? METAVERSE_PORTAL_POINTER_NAMES.filter((n) => tracker.capture.content.pointers[n])
          : [],
      consent_key: METAVERSE_PORTAL_CONSENT_KEY,
      consent_granted: !!(
        tracker.capture &&
        tracker.capture.content &&
        tracker.capture.content.consent &&
        tracker.capture.content.consent.granted
      ),
      record: tracker.record ? JSON.parse(JSON.stringify(tracker.record)) : null,
      last_status_line: tracker.lastStatusLine,
      demonstration_only: true,
    }),
    steps: () => STEPS.map((s) => ({ id: s.id, label: s.label })),
  };
}
