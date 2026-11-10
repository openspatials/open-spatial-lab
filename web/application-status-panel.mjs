import { createApplicationPhasePanel } from "./application-phase-panel.mjs";
import { escapeHtml } from "./application-debug-format.mjs";
import { reconcileKeyedHtml } from "./reconcile-keyed-html.mjs";
import { WORLDS } from "./worlds-list.mjs";

// The Lobby as the world list names it; the header's return-to-Lobby control is about that one world.
const LOBBY_LOCATION_ID = (WORLDS.find((world) => world.key === "lobby") || {}).location_id || null;

export function createApplicationStatusPanel({
  lookup: $,
  body,
  isPlayer,
  role,
  phases: HANDOFF_PHASES,
  notifications,
  getAdapter,
  canonicalDebugState,
  destinationLoadingContent,
  onConnectionChange,
  reload,
  listen,
  reconcile = reconcileKeyedHtml,
}) {
  const document = { body };
  const location = { reload };
  let disposed = false;
  let returnToLobbyInFlight = false;
  const showToast = (...args) => notifications.show(...args);
  const latestNotificationIdByKind = (kind) => notifications.latestByKind(kind);
  const publishNotificationRecord = (record) => notifications.publish(record);
  const CONNECTION_STATE_PRESENTATION = Object.freeze({
    loading: { label: "Loading", footer: "connecting to components 3 backend" },
    live: { label: "Live backend", footer: "real components 3 backend" },
    disconnected: {
      label: "Disconnected",
      footer: "components 3 backend unavailable",
    },
    unavailable: {
      label: "Temporarily unavailable",
      footer: "runtime temporarily unavailable",
    },
    refused: { label: "Runtime refused", footer: "trust or policy refusal" },
    error: {
      label: "Connection error",
      footer: "components 3 backend returned an error",
    },
  });
  let connectionPresentation = {
    state: "loading",
    detail: "Connecting to the live world…",
  };

  const phasePanel = createApplicationPhasePanel({
    lookup: $,
    isPlayer,
    phases: HANDOFF_PHASES,
    notifications,
    getAdapter,
    canonicalDebugState,
    destinationLoadingContent,
    getConnection: () => connectionPresentation,
    connectionStates: CONNECTION_STATE_PRESENTATION,
    setConnectionPresentation,
    reload,
  });
  const { renderOverlay } = phasePanel;

  function renderEquipment(status, avatar) {
    if (disposed) return;
    const list = $("equipment-list");
    const summary = $("equipment-summary");
    if (!list || !summary) return;
    const items =
      avatar && Array.isArray(avatar.equippedItems) ? avatar.equippedItems : [];
    const resolved = status && Array.isArray(status.items) ? status.items : [];
    const validation = status && status.validation ? status.validation : null;
    summary.textContent = validation
      ? validation.ok
        ? "schema PASS"
        : `schema FAIL: ${validation.errors.join("; ")}`
      : items.length
      ? "schema prepared"
      : "waiting for arrival packet";
    summary.className = validation && validation.ok ? "v boundary-ok" : "v";
    const html = items.length
      ? items
          .map((item) => {
            const r = resolved.find((entry) => entry.itemId === item.itemId);
            const fetchText = !r
              ? "fetch pending"
              : r.fetch_ok
              ? r.message
              : `${r.message} · visible fallback ${
                  r.visible_fallback ? "ON" : "OFF"
                }`;
            const cls =
              r && r.fetch_ok === false ? "equipment-bad" : "equipment-ok";
            return `<div class="equipment-row ${cls}" data-reconcile-key="equipment:${escapeHtml(
              item.itemId
            )}:${escapeHtml(item.attachmentPoint)}">
          <div><b>${escapeHtml(item.mode)}</b> ${escapeHtml(item.itemId)}</div>
          <div>${escapeHtml(item.attachmentPoint)}</div>
          <div>${escapeHtml(fetchText)}</div>
        </div>`;
          })
          .join("")
      : `<div class="equipment-row" data-reconcile-key="equipment-empty">No equipment manifest on this view yet.</div>`;
    reconcile(list, html);
  }

  function renderConnectionLabels(adapter, state) {
    document.body.setAttribute("data-connection-state", state);
    document.body.setAttribute(
      "data-connection-recoverable",
      String(connectionPresentation.recoverable)
    );
    document.body.setAttribute(
      "data-connection-current",
      connectionPresentation.current
    );
    if (connectionPresentation.failure_kind) {
      document.body.setAttribute(
        "data-connection-failure-kind",
        connectionPresentation.failure_kind
      );
    } else {
      document.body.removeAttribute("data-connection-failure-kind");
    }
    const header = $("connection-status");
    if (header) {
      header.className = `live-tag connection-${state}`;
      header.textContent = CONNECTION_STATE_PRESENTATION[state].label;
    }
    const footer = $("connection-footer-status");
    if (footer) {
      footer.innerHTML =
        `<span><span class="prov prov-${state}">${escapeHtml(
          state
        )}</span> ${escapeHtml(
          CONNECTION_STATE_PRESENTATION[state].footer
        )}</span>` + `<span>correlate by <b>handoff_id</b></span>`;
    }
    const provenance = $("connection-provenance");
    if (provenance) {
      provenance.className = `prov prov-${state}`;
      provenance.textContent = state;
    }
    const backend = $("live-backend");
    if (backend) {
      backend.textContent =
        state === "live" && adapter
          ? adapter.base
          : CONNECTION_STATE_PRESENTATION[state].footer;
      backend.style.color =
        state === "live"
          ? "var(--ok)"
          : state === "loading"
          ? "var(--warn)"
          : "var(--bad)";
    }
    const locationTitle = $("loc-title");
    if (locationTitle && isPlayer && (!adapter || !adapter.world)) {
      locationTitle.textContent =
        state === "loading"
          ? "Opening player world…"
          : "Player world unavailable";
    }
  }

  function setConnectionPresentation(state, detail, failedPath = null) {
    if (disposed) return;
    const adapter = getAdapter();
    if (
      !Object.prototype.hasOwnProperty.call(
        CONNECTION_STATE_PRESENTATION,
        state
      )
    )
      return;
    if (state === "error") state = "unavailable";
    const failure =
      failedPath && typeof failedPath === "object" ? failedPath : null;
    const path =
      typeof failedPath === "string"
        ? failedPath
        : failure && failure.path
        ? failure.path
        : null;
    const defaultRecovery =
      state === "disconnected" || state === "unavailable" || state === "error"
        ? {
            kind: "reload",
            label: "Reload & retry",
            aria_label: "Reload and retry this world",
            note: "Reloads this view because the live runtime boots as one coherent session.",
          }
        : null;
    const recovery =
      failure && Object.prototype.hasOwnProperty.call(failure, "recovery")
        ? failure.recovery
        : defaultRecovery;
    connectionPresentation = {
      state,
      detail: detail || CONNECTION_STATE_PRESENTATION[state].footer,
      failed_path: path,
      failure_kind:
        failure && failure.kind
          ? failure.kind
          : state === "loading" || state === "live"
          ? null
          : state,
      source_state:
        failure && failure.source_state ? failure.source_state : null,
      current:
        failure && failure.current
          ? failure.current
          : state === "live"
          ? "live-world"
          : "none",
      recoverable: state !== "refused" && !!recovery,
      recovery: state === "refused" ? null : recovery,
    };
    renderConnectionLabels(adapter, state);
    renderOverlay(
      adapter && adapter.state ? adapter.state.phase : HANDOFF_PHASES.IDLE,
      adapter && adapter.world
        ? canonicalDebugState(adapter.debugState())
        : null
    );
    onConnectionChange();
  }

  function handleConnectionApiRequest(event) {
    const request = event.detail || {};
    if (connectionPresentation.state === "loading") return;
    if (
      request.ok &&
      (connectionPresentation.state === "disconnected" ||
        connectionPresentation.state === "unavailable" ||
        connectionPresentation.state === "error") &&
      connectionPresentation.failed_path &&
      request.path === connectionPresentation.failed_path
    ) {
      setConnectionPresentation("live", "The live world connection recovered.");
    } else if (!request.ok && Number(request.status) === 0) {
      setConnectionPresentation(
        "disconnected",
        "The live world stopped responding. Reload and retry when the local services are available.",
        request.path || null
      );
    } else if (!request.ok && Number(request.status) >= 500) {
      setConnectionPresentation(
        "error",
        `The live world returned HTTP ${request.status}. Reload and retry after the service recovers.`,
        {
          path: request.path || null,
          kind: "service_http",
          source_state: `http_${request.status}`,
        }
      );
    }
  }

  function syncReturnLobbyButton(debug) {
    const btn = $("btn-return-lobby");
    if (!btn) return;
    const inLobby = !!(debug && LOBBY_LOCATION_ID && debug.location_id === LOBBY_LOCATION_ID);
    btn.hidden = !isPlayer || inLobby;
    btn.disabled = returnToLobbyInFlight || !isPlayer || inLobby;
    btn.setAttribute("aria-disabled", String(btn.disabled));
  }

  async function handleReturnLobbyClick() {
    const adapter = getAdapter();
    if (disposed || !adapter || returnToLobbyInFlight) return;
    returnToLobbyInFlight = true;
    syncReturnLobbyButton(adapter.debugState());
    try {
      const result = await adapter.returnToLobby();
      if (disposed) return;
      if (result && result.ok) {
        const notificationId = `return-to-lobby-${Date.now()}`;
        publishNotificationRecord({
          id: notificationId,
          kind: "navigation",
          event_type: "return_to_lobby",
          title: "Returned to lobby",
          summary: "Player returned to the lobby from the header control.",
          source: result.from
            ? {
                location_id: result.from.location_id,
                world_id: result.from.world_id,
              }
            : null,
          destination: result.to
            ? {
                location_id: result.to.location_id,
                world_id: result.to.world_id,
              }
            : { location_id: LOBBY_LOCATION_ID },
          no_page_reload: result.no_page_reload === true,
        });
        showToast(
          "Returned to lobby",
          "Player is back in the lobby.",
          "arrived",
          { notificationId }
        );
      } else {
        showToast(
          "Lobby return failed",
          result && result.reason
            ? result.reason
            : "Could not return to lobby.",
          "failed"
        );
      }
    } finally {
      returnToLobbyInFlight = false;
      if (!disposed) syncReturnLobbyButton(adapter.debugState());
    }
  }
  return Object.freeze({
    renderOverlay,
    renderEquipment,
    setConnectionPresentation,
    handleConnectionApiRequest,
    syncReturnLobbyButton,
    handleReturnLobbyClick,
    connectionStatus: () => ({ ...connectionPresentation }),
    dismissOrientation: phasePanel.dismissOrientation,
    orientationDismissed: phasePanel.orientationDismissed,
    renderState: phasePanel.renderState,
    mount() {
      const button = $("btn-return-lobby");
      if (
        !button ||
        !isPlayer ||
        button.dataset.returnLobbyWired === "1" ||
        disposed
      )
        return;
      button.dataset.returnLobbyWired = "1";
      listen(button, "click", handleReturnLobbyClick);
    },
    dispose() {
      phasePanel.dispose();
      disposed = true;
    },
  });
}
