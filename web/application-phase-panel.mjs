import { escapeHtml } from "./application-debug-format.mjs";
export function createApplicationPhasePanel({
  lookup: $,
  isPlayer,
  phases: HANDOFF_PHASES,
  connectionStates: CONNECTION_STATE_PRESENTATION,
  notifications,
  getAdapter,
  canonicalDebugState,
  destinationLoadingContent,
  getConnection,
  setConnectionPresentation,
  reload,
}) {
  let disposed = false;
  const location = { reload };
  const showToast = (...args) => notifications.show(...args);
  const latestNotificationIdByKind = (kind) => notifications.latestByKind(kind);
  let playerOrientationDismissed = false;
  const PORTAL_TRANSITION_PHASES = Object.freeze({
    WALKTHROUGH: "portal_walkthrough",
  });
  const PHASE_LABEL = {
    [HANDOFF_PHASES.IDLE]: { text: "idle", cls: "" },
    [HANDOFF_PHASES.PORTAL_ACTIVE]: { text: "portal active", cls: "" },
    [HANDOFF_PHASES.DEPARTED]: {
      text: "departed (avatar hidden)",
      cls: "departed",
    },
    [HANDOFF_PHASES.WAITING]: { text: "waiting for arrival", cls: "waiting" },
    [HANDOFF_PHASES.ARRIVED]: {
      text: "arrived (avatar visible)",
      cls: "arrived",
    },
    [PORTAL_TRANSITION_PHASES.WALKTHROUGH]: {
      text: "walking through portal",
      cls: "",
    },
  };
  let lastToastPhase = null;
  function renderConnectionCard(overlay) {
    const connectionPresentation = getConnection();
    const failed = connectionPresentation.state !== "loading";
    const heading =
      connectionPresentation.state === "loading"
        ? "Opening your world"
        : connectionPresentation.state === "disconnected"
        ? "World connection unavailable"
        : connectionPresentation.state === "refused"
        ? "This world was refused"
        : "The world is temporarily unavailable";
    const recovery = connectionPresentation.recovery;
    const recoveryMarkup = recovery
      ? `<div class="player-first-frame-actions">
        <button class="primary" id="btn-connection-retry" data-testid="connection-retry" type="button"
          aria-label="${escapeHtml(
            recovery.aria_label || recovery.label
          )}">${escapeHtml(recovery.label)}</button>
        <span class="recovery-note">${escapeHtml(recovery.note)}</span>
      </div>`
      : connectionPresentation.state === "refused"
      ? `<div class="recovery-note" data-testid="connection-terminal-refusal">Retry is unavailable because this is a trust or policy refusal.</div>`
      : "";
    overlay.innerHTML = `<section class="player-first-frame" data-testid="player-connection-card"
      data-connection-state="${escapeHtml(connectionPresentation.state)}"
      data-failure-kind="${escapeHtml(
        connectionPresentation.failure_kind || "none"
      )}"
      data-recoverable="${String(connectionPresentation.recoverable === true)}"
      data-current-runtime="${escapeHtml(
        connectionPresentation.current || "none"
      )}"
      role="${failed ? "alert" : "status"}" aria-live="${
      failed ? "assertive" : "polite"
    }">
      <div class="eyebrow">${escapeHtml(
        CONNECTION_STATE_PRESENTATION[connectionPresentation.state].label
      )}</div>
      <h1>${escapeHtml(heading)}</h1>
      <p>${escapeHtml(connectionPresentation.detail)}</p>
      ${recoveryMarkup}
    </section>`;
    const retry = $("btn-connection-retry");
    if (retry && recovery) {
      retry.addEventListener("click", () => {
        if (disposed) return;
        if (recovery.kind === "return") {
          setConnectionPresentation(
            "live",
            recovery.success_detail ||
              "The last verified world remains active.",
            { current: recovery.current || "verified-parent", recovery: null }
          );
        } else {
          location.reload();
        }
      });
    }
  }
  function renderOrientationCard(overlay, phase, dbg) {
    const adapter = getAdapter();
    const title =
      dbg && dbg.world_title
        ? dbg.world_title
        : adapter && adapter.world && adapter.world.title
        ? adapter.world.title
        : "the Open Spatial Lab";
    overlay.innerHTML = `<section class="player-first-frame" data-testid="player-first-frame"
      data-connection-state="live" role="region" aria-label="Player orientation">
      <div class="eyebrow">Live · ${escapeHtml(title)}</div>
      <h1>You’re in ${escapeHtml(title)}</h1>
      <p>Explore this world as the player, then walk through a lit portal to continue into the connected space.</p>
      <div class="player-first-frame-controls">W A S D to walk · drag to look · scroll to zoom · Shift to run</div>
      <div class="player-first-frame-actions">
        <button class="primary" id="btn-start-exploring" data-testid="start-exploring" type="button">Start exploring</button>
      </div>
    </section>`;
    const start = $("btn-start-exploring");
    if (start) {
      start.addEventListener("click", () => {
        if (disposed) return;
        playerOrientationDismissed = true;
        renderOverlay(phase, dbg);
      });
    }
  }
  function showArrival(dbg) {
    const adapter = getAdapter();
    const resumeMs =
      dbg &&
      dbg.crossing &&
      Number.isFinite(Number(dbg.crossing.controls_resume_ms))
        ? Number(dbg.crossing.controls_resume_ms)
        : null;
    const prefetchProof =
      dbg &&
      dbg.last_handoff_payload &&
      dbg.last_handoff_payload.fabric_prefetch_proof
        ? dbg.last_handoff_payload.fabric_prefetch_proof
        : null;
    const prefetchText = prefetchProof
      ? prefetchProof.used
        ? "fabric prefetched"
        : "cold crossing"
      : null;
    const destContent = isPlayer ? destinationLoadingContent() : null;
    const destBrandEntry =
      destContent && destContent.content && destContent.content.pointers
        ? destContent.content.pointers["metaverse.portal.loadingBranding"]
        : null;
    const destTitleText =
      destBrandEntry && destBrandEntry.value && destBrandEntry.value.world_title
        ? destBrandEntry.value.world_title
        : adapter && adapter.world && adapter.world.title;
    const destTitle = destTitleText
      ? String(destTitleText).replace(/[<>&"]/g, "")
      : null;
    const arrivalHeadline = isPlayer
      ? ["ARRIVED", destTitle, resumeMs != null ? `${resumeMs} MS` : null]
          .filter(Boolean)
          .join(" · ")
      : "ARRIVAL RECEIVED";
    showToast(
      arrivalHeadline,
      isPlayer
        ? [prefetchText, "live crossing", "same page, no reload"]
            .filter(Boolean)
            .join(" · ")
        : "arrival applied locally · return portal active",
      "toast-arrived",
      { notificationId: latestNotificationIdByKind("portal_through_loading") }
    );
  }
  function renderOverlay(phase, dbg) {
    const connectionPresentation = getConnection();
    if (disposed) return;
    const overlay = $("state-overlay");
    if (!overlay) return;
    overlay.className = "state-overlay " + (PHASE_LABEL[phase]?.cls || "");
    if (isPlayer && connectionPresentation.state !== "live")
      return renderConnectionCard(overlay);
    if (isPlayer && !playerOrientationDismissed)
      return renderOrientationCard(overlay, phase, dbg);
    overlay.innerHTML = "";
    if (phase !== lastToastPhase) {
      lastToastPhase = phase;
      if (phase === HANDOFF_PHASES.PORTAL_ACTIVE) {
        showToast(
          "Portal active",
          "at traversal trigger — walk through to cross",
          "toast-departed"
        );
      }
      if (phase === HANDOFF_PHASES.DEPARTED) {
        showToast(
          isPlayer ? "Crossing" : "Departed",
          isPlayer
            ? "promoting target fabric to root — same context, no reload"
            : "exit intent POSTed · local avatar hidden",
          "toast-departed"
        );
      }
      if (phase === HANDOFF_PHASES.ARRIVED) showArrival(dbg);
    }
  }
  return Object.freeze({
    renderOverlay,
    dismissOrientation(phase, debug) {
      if (disposed) return;
      playerOrientationDismissed = true;
      renderOverlay(phase, debug);
    },
    orientationDismissed: () => playerOrientationDismissed,
    renderState(debug) {
      const phase = debug.phase;
      $("phase-pill").textContent = (
        PHASE_LABEL[phase] || { text: phase }
      ).text;
      renderOverlay(phase, debug);
    },
    dispose() {
      disposed = true;
    },
  });
}
