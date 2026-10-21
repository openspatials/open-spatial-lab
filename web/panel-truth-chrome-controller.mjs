import { createPresentationJsonViewer } from "./presentation-json-viewer.mjs";
import { resolveGlassLever } from "./render-quality-levers.mjs";

const LEGACY_PANEL_SIZE_STORAGE_KEY = "osl-floating-panel-size-v1";
const RAIL_WIDTH_MIN = 260;
const PANEL_HEIGHT_MIN = 240;
const RAIL_WIDTH_STEP = 24;
const PANEL_HEIGHT_STEP = 24;
const WOW_API_LOG_RENDER_LIMIT = 24;
const WOW_API_LOG_MEMORY_LIMIT = 128;
const ACTIVITY_JOURNAL_MEMORY_LIMIT = 80;
const ACTIVITY_JOURNAL_RENDER_LIMIT = 40;

export function assertPanelTruthChromeControllerContract(controller) {
  if (!controller || typeof controller.recordActivity !== "function") {
    throw new TypeError("Panel truth/chrome controller contract requires recordActivity(input)");
  }
  return controller;
}

export function createPanelTruthChromeController(options = {}) {
  const {
    lookup,
    documentTarget,
    windowTarget,
    body,
    appRoot,
    apiEvents,
    isPlayer = false,
    reconcileKeyedHtml,
    writeDebugText,
    writeDebugBool,
    logLine = () => {},
    nowMs = () => Date.now(),
    requestFrame = (callback) => windowTarget.requestAnimationFrame(callback),
    cancelFrame = (frame) => windowTarget.cancelAnimationFrame(frame),
    storage = null,
    MutationObserverClass = null,
    ResizeObserverClass = null,
    getCapabilities = () => ({}),
    resizeSceneSurfaces = () => {},
    wirePortalSettingsModal = () => {},
    buildAndSignManifest,
    verifyManifestSignature,
    makeAvatarDefinition,
    makeLoadingPointer,
    buildLoadingPointersForManifest,
    getDestinationLoadingContent = () => null,
  } = options;

  if (typeof lookup !== "function" || !documentTarget || !windowTarget || !body) {
    throw new Error("panel truth/chrome controller requires explicit DOM roots");
  }

  const presentationViewer = createPresentationJsonViewer({
    lookup,
    documentTarget,
    windowTarget,
    body,
  });

  const listeners = [];
  const observers = [];
  const ownedFrames = new Set();
  const wowApiLog = [];
  const activityJournal = [];
  let wowApiLogSequence = 0;
  let activitySequence = 0;
  let journalFilter = "all";
  let journalNewestFirst = true;
  let glassLever = null;
  let previousLiveState = null;
  let wowHeldPacket = null;
  let mounted = false;
  let mountCount = 0;
  let apiMounted = false;
  let railFrame = 0;
  let resizeFrame = 0;
  let lastViewMatchAt = 0;
  let viewMatchInFlight = false;
  let lastManifest = null;
  let lastManifestKey = null;
  let apiEventAttached = false;
  let lifecycleToken = 0;
  let manualPanelSize = null;
  let manualPanelPosition = null;
  const controllerIdentity = Object.freeze({ owner: "panel-truth-chrome-controller", version: "runtime" });

  const on = (target, type, listener, settings) => {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, listener, settings);
    listeners.push(() => target.removeEventListener(type, listener, settings));
  };
  const capabilities = () => getCapabilities() || {};
  const wowEscape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const queueFrame = (callback) => {
    const frame = requestFrame(() => {
      ownedFrames.delete(frame);
      callback();
    });
    ownedFrames.add(frame);
    return frame;
  };

  function panelCards() {
    const rail = documentTarget.querySelector("aside.rail");
    return rail ? Array.from(rail.querySelectorAll("[data-panel-card]")) : [];
  }

  function syncPanelState() {
    const cards = panelCards();
    const groups = Array.from(documentTarget.querySelectorAll("[data-panel-group]"));
    body.setAttribute("data-panel-group-count", String(groups.length));
    body.setAttribute("data-panel-card-count", String(cards.length));
    body.setAttribute(
      "data-panel-collapsed-card-count",
      String(cards.filter((card) => card.classList.contains("section-collapsed")).length)
    );
    for (const group of groups) {
      const name = group.getAttribute("data-panel-group");
      const button = group.querySelector(":scope > .panel-group-heading > .panel-group-toggle");
      if (name && button) {
        body.setAttribute(`data-panel-group-${name}-expanded`, button.getAttribute("aria-expanded") || "false");
      }
    }
  }

  function findPanelGroup(name) {
    return Array.from(documentTarget.querySelectorAll("[data-panel-group]"))
      .find((group) => group.getAttribute("data-panel-group") === name) || null;
  }

  function setGroupExpanded(name, expanded, settings = {}) {
    const group = findPanelGroup(name);
    if (!group) return false;
    const button = group.querySelector(":scope > .panel-group-heading > .panel-group-toggle");
    const groupBody = group.querySelector(":scope > .panel-group-body");
    if (!button || !groupBody) return false;
    const next = expanded === true;
    if (!next && groupBody.contains(documentTarget.activeElement)) button.focus();
    button.setAttribute("aria-expanded", String(next));
    groupBody.hidden = !next;
    group.classList.toggle("panel-group-collapsed", !next);
    syncPanelState();
    if (settings.announce !== false) {
      recordActivity({
        message: `${button.firstElementChild ? button.firstElementChild.textContent : name} ${next ? "expanded" : "collapsed"}`,
        eventClass: "state",
        severity: "info",
      });
    }
    queueFrame(() => {
      try { windowTarget.dispatchEvent(new windowTarget.Event("resize")); } catch {}
    });
    return next;
  }

  function setCardExpanded(card, expanded) {
    if (!card) return false;
    const heading = card.querySelector(":scope > h3");
    const sectionBody = card.querySelector(":scope > .section-body");
    const next = expanded === true;
    card.classList.toggle("section-collapsed", !next);
    if (heading) heading.setAttribute("aria-expanded", String(next));
    // The section class owns child-card disclosure. Keeping the body out of the
    // native hidden state also lets portal focus/open helpers reveal a card by
    // removing `section-collapsed` without needing a second state mutation.
    if (sectionBody) sectionBody.hidden = false;
    syncPanelState();
    return next;
  }

  function wirePanelGroups() {
    for (const group of documentTarget.querySelectorAll("[data-panel-group]")) {
      const name = group.getAttribute("data-panel-group");
      const button = group.querySelector(":scope > .panel-group-heading > .panel-group-toggle");
      if (!name || !button) continue;
      const initial = group.getAttribute("data-default-expanded") === "true";
      setGroupExpanded(name, initial, { announce: false });
      on(button, "click", () => {
        setGroupExpanded(name, button.getAttribute("aria-expanded") !== "true");
      });
    }
  }

  function wirePanelCards() {
    for (const card of panelCards()) {
      const heading = card.querySelector(":scope > h3");
      if (!heading) continue;
      let sectionBody = card.querySelector(":scope > .section-body");
      if (!sectionBody) {
        sectionBody = documentTarget.createElement("div");
        sectionBody.className = "section-body";
        sectionBody.id = `panel-card-body-${card.getAttribute("data-panel-card")}`;
        let node = heading.nextSibling;
        while (node) {
          const next = node.nextSibling;
          sectionBody.appendChild(node);
          node = next;
        }
        card.appendChild(sectionBody);
      }
      heading.setAttribute("role", "button");
      heading.setAttribute("tabindex", "0");
      heading.setAttribute("aria-controls", sectionBody.id);
      const initial = card.getAttribute("data-default-expanded") === "true";
      setCardExpanded(card, initial);
      const toggle = () => setCardExpanded(card, card.classList.contains("section-collapsed"));
      on(heading, "click", toggle);
      on(heading, "keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      });
    }
  }

  function journalEscape(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character]));
  }

  function classifyActivity(message, explicitSeverity) {
    if (explicitSeverity === "fatal" || explicitSeverity === "warning" || explicitSeverity === "info") {
      return explicitSeverity;
    }
    if (/\bfatal\b|uncaught|unhandled|validation-boundary failure/i.test(message)) return "fatal";
    if (/\bwarn(?:ing)?\b|\bfailed\b|\berror\b|\brefused\b|\brejected\b|\bdisconnect/i.test(message)) {
      return "warning";
    }
    return "info";
  }

  function normalizeActivityMessage(message) {
    if (/^runtime: through-portal loading record OPEN/i.test(message)) return "Destination loading started";
    if (/^runtime: through-portal loading record COMPLETE/i.test(message)) return "Destination loading completed";
    if (/^portal clicked:/i.test(message)) return "Portal selected; destination preview opened";
    return message;
  }

  function isJournalNoise(message, severity, eventClass) {
    if (severity !== "info") return false;
    if (/runtime-state tick|preview frame|presence heartbeat|visibility broadcast/i.test(message)) return true;
    if (/portal-render validation active|frontend contract exposed|claim ceiling|standards-conformance claim/i.test(message)) return true;
    return eventClass === "network"
      && /\/wow\/view(?:\/|\b)|\/fabric\/presence(?:\/heartbeat)?(?:\b|\?)|\/demo\/portal-view(?:\b|\?)/i.test(message);
  }

  function renderActivityJournal() {
    const root = lookup("activity-journal");
    const summary = lookup("activity-journal-summary");
    if (!root || typeof reconcileKeyedHtml !== "function") return;
    const filtered = activityJournal.filter((event) => {
      if (journalFilter === "state") return event.eventClass === "state";
      if (journalFilter === "warning") return event.severity === "warning" || event.severity === "fatal";
      return true;
    });
    const ordered = journalNewestFirst ? filtered.slice().reverse() : filtered.slice();
    const visible = ordered.slice(0, ACTIVITY_JOURNAL_RENDER_LIMIT);
    const html = visible.length
      ? visible.map((event) => {
          const count = event.count > 1 ? ` ×${event.count}` : "";
          return `<li data-reconcile-key="activity-${event.id}" data-severity="${journalEscape(event.severity)}" data-event-class="${journalEscape(event.eventClass)}">
            <time datetime="${journalEscape(event.at)}">${journalEscape(event.timeLabel)}</time>
            <span class="journal-severity">${journalEscape(event.severity)}${count}</span>
            <span class="journal-message">${journalEscape(event.message)}</span>
          </li>`;
        }).join("")
      : '<li class="journal-empty" data-reconcile-key="activity-empty">No events match this filter.</li>';
    reconcileKeyedHtml(root, html);
    if (summary) {
      summary.textContent = `${journalNewestFirst ? "Newest" : "Oldest"} first · ${filtered.length} matching · ${activityJournal.length} of ${ACTIVITY_JOURNAL_MEMORY_LIMIT} retained meaningful events`;
    }
    body.setAttribute("data-activity-journal-count", String(activityJournal.length));
    body.setAttribute("data-activity-journal-filter", journalFilter);
    body.setAttribute("data-activity-journal-order", journalNewestFirst ? "newest" : "oldest");
  }

  function recordActivity(input) {
    const value = typeof input === "string" ? { message: input } : (input || {});
    const message = normalizeActivityMessage(String(value.message || "").trim());
    if (!message) return null;
    const severity = classifyActivity(message, value.severity);
    const eventClass = value.eventClass || (severity === "info" ? "runtime" : "warning");
    if (isJournalNoise(message, severity, eventClass)) return null;
    const last = activityJournal.length ? activityJournal[activityJournal.length - 1] : null;
    const atMs = Date.now();
    if (last && last.message === message && last.severity === severity && last.eventClass === eventClass && atMs - last.atMs < 2000) {
      last.count += 1;
      last.atMs = atMs;
      last.at = new Date(atMs).toISOString();
      last.timeLabel = last.at.slice(11, 19);
      renderActivityJournal();
      return { ...last };
    }
    const at = value.at || new Date(atMs).toISOString();
    const event = {
      id: ++activitySequence,
      message,
      severity,
      eventClass,
      at,
      atMs,
      timeLabel: String(at).slice(11, 19),
      count: 1,
    };
    activityJournal.push(event);
    if (activityJournal.length > ACTIVITY_JOURNAL_MEMORY_LIMIT) {
      activityJournal.splice(0, activityJournal.length - ACTIVITY_JOURNAL_MEMORY_LIMIT);
    }
    renderActivityJournal();
    return { ...event };
  }

  function wireActivityJournal() {
    for (const button of documentTarget.querySelectorAll("[data-journal-filter]")) {
      on(button, "click", () => {
        journalFilter = button.getAttribute("data-journal-filter") || "all";
        for (const peer of documentTarget.querySelectorAll("[data-journal-filter]")) {
          peer.setAttribute("aria-pressed", String(peer === button));
        }
        renderActivityJournal();
      });
    }
    const order = lookup("activity-journal-order");
    if (order) {
      on(order, "click", () => {
        journalNewestFirst = !journalNewestFirst;
        order.setAttribute("aria-pressed", String(journalNewestFirst));
        order.textContent = journalNewestFirst ? "Newest first" : "Oldest first";
        renderActivityJournal();
      });
    }
    on(windowTarget, "error", (event) => {
      const location = event && event.filename ? ` · ${event.filename}:${event.lineno || 0}` : "";
      recordActivity({
        message: `Fatal browser error: ${event && event.message ? event.message : "unknown error"}${location}`,
        eventClass: "runtime",
        severity: "fatal",
      });
    });
    on(windowTarget, "unhandledrejection", (event) => {
      const reason = event && event.reason;
      recordActivity({
        message: `Fatal unhandled rejection: ${reason && reason.message ? reason.message : String(reason || "unknown rejection")}`,
        eventClass: "runtime",
        severity: "fatal",
      });
    });
    renderActivityJournal();
  }

  function updateCardMeta(id, message, tone = "info") {
    const element = lookup(id);
    if (!element) return;
    element.textContent = `${message} · ${new Date().toISOString().slice(11, 19)}`;
    element.setAttribute("data-tone", tone);
  }

  function liveStateSnapshot(debug) {
    const signing = debug && debug.um_signing ? debug.um_signing : null;
    const profile = debug && debug.player_handoff_profile ? debug.player_handoff_profile : null;
    return {
      location: debug && (debug.location_id || (debug.active && debug.active.location_id)) || "—",
      phase: debug && debug.phase || "—",
      navigator: debug && debug.navigator ? debug.navigator.status || "—" : "—",
      prefetch: debug && debug.fabric_prefetch ? debug.fabric_prefetch.status || "—" : "—",
      handoff: debug && debug.handoff_id || "—",
      um: signing && signing.verified_on_arrival
        ? `arrival:${String(signing.verified_on_arrival.verified)}`
        : signing && signing.signed_on_exit
          ? `exit:${String(signing.signed_on_exit.signed)}`
          : "waiting",
      iwps: profile && profile.iwps_query_teleport
        ? profile.iwps_query_teleport.teleport ? "teleport" : "query"
        : "waiting",
    };
  }

  function recordStateChanges(debug) {
    if (!debug) return;
    const next = liveStateSnapshot(debug);
    if (!previousLiveState) {
      previousLiveState = next;
      recordActivity({
        message: `Runtime ready in ${next.location} · phase ${next.phase}`,
        eventClass: "state",
        severity: "info",
      });
      updateCardMeta("runtime-source-activity-meta", `Live adapter · ${next.location}`);
      updateCardMeta("world-context-activity-meta", `Navigator ${next.navigator}`);
      updateCardMeta("portal-transition-activity-meta", `Phase ${next.phase}`);
      updateCardMeta("fabric-prefetch-activity-meta", `Prefetch ${next.prefetch}`);
      return;
    }
    const descriptions = {
      location: ["World", "world-context-activity-meta"],
      phase: ["Transition", "portal-transition-activity-meta"],
      navigator: ["Navigator", "world-context-activity-meta"],
      prefetch: ["Prefetch", "fabric-prefetch-activity-meta"],
      handoff: ["Handoff", "portal-transition-activity-meta"],
      um: ["Manifest", "std-um-activity-meta"],
      iwps: ["IWPS", "std-iwps-activity-meta"],
    };
    for (const [key, [label, metaId]] of Object.entries(descriptions)) {
      if (next[key] === previousLiveState[key]) continue;
      const message = `${label}: ${previousLiveState[key]} → ${next[key]}`;
      const severity = /fail|reject|refus|error/i.test(next[key]) ? "warning" : "info";
      recordActivity({ message, eventClass: "state", severity });
      updateCardMeta(metaId, message, severity);
    }
    previousLiveState = next;
  }

  function renderLiveContractSummary(debug) {
    const cap = capabilities();
    let info = null;
    try { info = typeof cap.apiPanelInfo === "function" ? cap.apiPanelInfo() : null; } catch { info = null; }
    const validation = info && info.wow_contract_validation ? info.wow_contract_validation : null;
    const identity = lookup("wow-spec-identity");
    if (identity && info && info.spec_identity) {
      const state = validation
        ? validation.status === "passed"
          ? `contract valid · ${validation.passed} responses`
          : validation.status === "failed"
            ? `contract warning · ${validation.failed + validation.errors} failures`
            : "validation not observed"
        : "validation not observed";
      identity.textContent = `${info.spec_identity.spec_file} · OpenAPI ${info.spec_identity.openapi} · ${state}`;
      updateCardMeta(
        "wow-activity-meta",
        state,
        validation && validation.status === "failed" ? "warning" : "info"
      );
    }
    recordStateChanges(debug);
  }

  function groupDriver() {
    return {
      state: () => Array.from(documentTarget.querySelectorAll("[data-panel-group]")).map((group) => {
        const button = group.querySelector(":scope > .panel-group-heading > .panel-group-toggle");
        return {
          name: group.getAttribute("data-panel-group"),
          expanded: !!button && button.getAttribute("aria-expanded") === "true",
        };
      }),
      setExpanded: (name, expanded) => setGroupExpanded(name, expanded),
      cards: () => panelCards().map((card) => ({
        id: card.getAttribute("data-panel-card"),
        title: card.querySelector(":scope > h3")?.textContent.trim() || "",
      })),
      journal: () => activityJournal.map((event) => ({ ...event })),
      recordActivity,
    };
  }


  function currentPanelSize() {
    const rail = documentTarget.querySelector("aside.rail");
    const rectangle = rail ? rail.getBoundingClientRect() : null;
    return {
      width: Math.max(1, Math.round((rectangle && rectangle.width) || RAIL_WIDTH_MIN)),
      height: Math.max(1, Math.round((rectangle && rectangle.height) || PANEL_HEIGHT_MIN)),
    };
  }

  function panelSizeBounds() {
    const rail = documentTarget.querySelector("aside.rail");
    const header = documentTarget.querySelector("header.role-banner");
    const footer = documentTarget.querySelector("footer.controls");
    const viewportWidth = Math.max(1, Number(windowTarget.innerWidth) || 1);
    const viewportHeight = Math.max(1, Number(windowTarget.innerHeight) || 1);
    const edge = viewportWidth <= 620 ? 8 : 12;
    const railTop = rail && rail.getBoundingClientRect().top > 0
      ? rail.getBoundingClientRect().top
      : ((header && header.getBoundingClientRect().bottom) || 68) + edge;
    const footerTop = footer && footer.getBoundingClientRect().top > railTop
      ? footer.getBoundingClientRect().top
      : viewportHeight;
    const maxWidth = Math.max(1, Math.min(640, viewportWidth - (edge * 2)));
    const maxHeight = Math.max(1, footerTop - railTop - edge);
    return {
      minWidth: Math.min(RAIL_WIDTH_MIN, maxWidth),
      maxWidth,
      minHeight: Math.min(PANEL_HEIGHT_MIN, maxHeight),
      maxHeight,
      edge,
    };
  }

  function clampPanelSize(size) {
    if (!size || typeof size !== "object") return null;
    const width = Number(size.width);
    const height = Number(size.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    const bounds = panelSizeBounds();
    return {
      width: Math.min(bounds.maxWidth, Math.max(bounds.minWidth, Math.round(width))),
      height: Math.min(bounds.maxHeight, Math.max(bounds.minHeight, Math.round(height))),
      bounds,
    };
  }

  function syncPanelControls(size = currentPanelSize(), bounds = panelSizeBounds()) {
    const widthHandle = lookup("rail-resizer");
    const heightHandle = lookup("panel-height-resizer");
    body.setAttribute("data-panel-dock", manualPanelPosition ? "free" : "right");
    body.setAttribute("data-panel-size-mode", manualPanelSize ? "manual" : "auto");
    body.setAttribute("data-rail-width", String(size.width));
    body.setAttribute("data-panel-height", String(size.height));
    if (widthHandle) {
      widthHandle.setAttribute("aria-valuenow", String(size.width));
      widthHandle.setAttribute("aria-valuemin", String(bounds.minWidth));
      widthHandle.setAttribute("aria-valuemax", String(bounds.maxWidth));
    }
    if (heightHandle) {
      heightHandle.setAttribute("aria-valuenow", String(size.height));
      heightHandle.setAttribute("aria-valuemin", String(bounds.minHeight));
      heightHandle.setAttribute("aria-valuemax", String(bounds.maxHeight));
    }
  }

  function applyPanelSize(size, settings = {}) {
    if (!size) {
      manualPanelSize = null;
      body.style.removeProperty("--rail-w");
      body.style.removeProperty("--rail-h");
      syncPanelControls();
      if (settings.notify !== false) {
        try { windowTarget.dispatchEvent(new windowTarget.Event("resize")); } catch {}
      }
      return null;
    }
    const preferred = { width: Number(size.width), height: Number(size.height) };
    const clamped = clampPanelSize(preferred);
    if (!clamped) return null;
    if (settings.updatePreferred !== false) manualPanelSize = preferred;
    body.style.setProperty("--rail-w", `${clamped.width}px`);
    body.style.setProperty("--rail-h", `${clamped.height}px`);
    syncPanelControls(clamped, clamped.bounds);
    if (manualPanelPosition) applyPanelPosition(manualPanelPosition);
    if (settings.notify !== false) {
      try { windowTarget.dispatchEvent(new windowTarget.Event("resize")); } catch {}
    }
    return { width: clamped.width, height: clamped.height };
  }

  function applyRailWidth(px, settings = {}) {
    if (px == null || px === "") return applyPanelSize(null, settings);
    const current = manualPanelSize || currentPanelSize();
    const result = applyPanelSize({ width: px, height: current.height }, settings);
    return result ? result.width : null;
  }

  function applyPanelPosition(position) {
    if (!position) {
      manualPanelPosition = null;
      body.style.removeProperty("--rail-top");
      body.style.removeProperty("--rail-left");
      body.style.removeProperty("--rail-right");
      syncPanelControls();
      return null;
    }
    const rail = documentTarget.querySelector("aside.rail");
    const header = documentTarget.querySelector("header.role-banner");
    const footer = documentTarget.querySelector("footer.controls");
    const rectangle = rail ? rail.getBoundingClientRect() : null;
    const bounds = panelSizeBounds();
    const width = Math.max(1, Number(rectangle?.width) || currentPanelSize().width);
    const height = Math.max(1, Number(rectangle?.height) || currentPanelSize().height);
    const headerBottom = Number(header?.getBoundingClientRect().bottom) || 68;
    const footerTop = Number(footer?.getBoundingClientRect().top) || windowTarget.innerHeight;
    const minTop = headerBottom + bounds.edge;
    const maxLeft = Math.max(bounds.edge, windowTarget.innerWidth - width - bounds.edge);
    const maxTop = Math.max(minTop, footerTop - height - bounds.edge);
    manualPanelPosition = {
      left: Math.min(maxLeft, Math.max(bounds.edge, Math.round(Number(position.left) || 0))),
      top: Math.min(maxTop, Math.max(minTop, Math.round(Number(position.top) || 0))),
    };
    body.style.setProperty("--rail-top", `${manualPanelPosition.top}px`);
    body.style.setProperty("--rail-left", `${manualPanelPosition.left}px`);
    body.style.setProperty("--rail-right", "auto");
    syncPanelControls();
    return { ...manualPanelPosition };
  }

  function resetPanelGeometry(settings = {}) {
    applyPanelSize(null, { notify: false });
    applyPanelPosition(null);
    if (settings.notify !== false) {
      try { windowTarget.dispatchEvent(new windowTarget.Event("resize")); } catch {}
    }
  }

  function syncPanelDock() {
    if (manualPanelSize) {
      applyPanelSize(manualPanelSize, { notify: false, updatePreferred: false });
    }
    if (manualPanelPosition) return applyPanelPosition(manualPanelPosition);
    syncPanelControls();
    return null;
  }

  function wireRailResizer() {
    const rail = documentTarget.querySelector("aside.rail");
    const handles = [
      { element: lookup("rail-resizer"), axis: "width" },
      { element: lookup("panel-height-resizer"), axis: "height" },
    ].filter((entry) => entry.element);
    try { if (storage) storage.removeItem(LEGACY_PANEL_SIZE_STORAGE_KEY); } catch {}
    resetPanelGeometry({ notify: false });
    for (const { element: handle, axis } of handles) {
      let dragging = false;
      let pendingSize = null;
      const sizeFromEvent = (event) => {
        const rectangle = rail ? rail.getBoundingClientRect() : { top: 0, right: windowTarget.innerWidth };
        const current = manualPanelSize || currentPanelSize();
        return axis === "width"
          ? { width: rectangle.right - event.clientX, height: current.height, left: event.clientX }
          : { width: current.width, height: event.clientY - rectangle.top };
      };
      const flush = () => {
        railFrame = 0;
        if (!pendingSize) return;
        const next = pendingSize;
        pendingSize = null;
        applyPanelSize(next, { notify: false });
        if (manualPanelPosition && Number.isFinite(next.left)) {
          applyPanelPosition({ ...manualPanelPosition, left: next.left });
        }
      };
      const pointerDown = (event) => {
        if (event.button != null && event.button !== 0) return;
        dragging = true;
        handle.setAttribute("data-dragging", "1");
        body.setAttribute("data-rail-dragging", axis);
        try { handle.setPointerCapture(event.pointerId); } catch {}
        event.preventDefault();
      };
      const pointerMove = (event) => {
        if (!dragging) return;
        pendingSize = sizeFromEvent(event);
        if (!railFrame) railFrame = requestFrame(flush);
        event.preventDefault();
      };
      const endDrag = (event) => {
        if (!dragging) return;
        dragging = false;
        handle.removeAttribute("data-dragging");
        body.removeAttribute("data-rail-dragging");
        try { handle.releasePointerCapture(event.pointerId); } catch {}
        if (railFrame) { cancelFrame(railFrame); railFrame = 0; }
        const finalSize = pendingSize || sizeFromEvent(event);
        pendingSize = null;
        applyPanelSize(finalSize);
        if (manualPanelPosition && Number.isFinite(finalSize.left)) {
          applyPanelPosition({ ...manualPanelPosition, left: finalSize.left });
        }
      };
      const keyDown = (event) => {
        const current = manualPanelSize || currentPanelSize();
        let next = null;
        if (axis === "width" && event.key === "ArrowLeft") next = { ...current, width: current.width + RAIL_WIDTH_STEP };
        else if (axis === "width" && event.key === "ArrowRight") next = { ...current, width: current.width - RAIL_WIDTH_STEP };
        else if (axis === "height" && event.key === "ArrowUp") next = { ...current, height: current.height - PANEL_HEIGHT_STEP };
        else if (axis === "height" && event.key === "ArrowDown") next = { ...current, height: current.height + PANEL_HEIGHT_STEP };
        else if (event.key === "Home") applyPanelSize(null);
        else return;
        if (next) applyPanelSize(next);
        event.preventDefault();
      };
      on(handle, "pointerdown", pointerDown);
      on(handle, "pointermove", pointerMove);
      on(handle, "pointerup", endDrag);
      on(handle, "pointercancel", endDrag);
      on(handle, "keydown", keyDown);
      on(handle, "dblclick", () => applyPanelSize(null));
    }
    on(windowTarget, "resize", () => queueFrame(syncPanelDock), { passive: true });
    syncPanelDock();
  }

  function wirePanelDrag() {
    const rail = documentTarget.querySelector("aside.rail");
    const dragRegion = documentTarget.querySelector(".panel-control-strip");
    const closeButton = lookup("btn-panel-close");
    if (!rail || !dragRegion) return;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    const pointerDown = (event) => {
      if (event.button != null && event.button !== 0) return;
      if (closeButton && closeButton.contains(event.target)) return;
      const rectangle = rail.getBoundingClientRect();
      dragging = true;
      offsetX = event.clientX - rectangle.left;
      offsetY = event.clientY - rectangle.top;
      dragRegion.setAttribute("data-dragging", "1");
      body.setAttribute("data-panel-dragging", "true");
      try { dragRegion.setPointerCapture(event.pointerId); } catch {}
      event.preventDefault();
    };
    const pointerMove = (event) => {
      if (!dragging) return;
      applyPanelPosition({ left: event.clientX - offsetX, top: event.clientY - offsetY });
      event.preventDefault();
    };
    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      dragRegion.removeAttribute("data-dragging");
      body.removeAttribute("data-panel-dragging");
      try { dragRegion.releasePointerCapture(event.pointerId); } catch {}
    };
    on(dragRegion, "pointerdown", pointerDown);
    on(dragRegion, "pointermove", pointerMove);
    on(dragRegion, "pointerup", endDrag);
    on(dragRegion, "pointercancel", endDrag);
  }

  function setPanelOpen(open, settings = {}) {
    const next = open === true;
    const wasOpen = !appRoot?.classList.contains("rail-collapsed");
    const rail = documentTarget.querySelector("aside.rail");
    const railToggle = lookup("btn-rail-toggle");
    if (!next && rail && rail.contains(documentTarget.activeElement) && settings.focusToggle !== false) {
      railToggle?.focus();
    }
    if (next && !wasOpen) resetPanelGeometry({ notify: false });
    appRoot?.classList.toggle("rail-collapsed", !next);
    body.setAttribute("data-panel-open", String(next));
    if (railToggle) railToggle.setAttribute("aria-expanded", String(next));
    if (settings.announce === true) {
      recordActivity({ message: `Inspector panel ${next ? "opened" : "closed"}`, eventClass: "state", severity: "info" });
    }
    queueFrame(() => {
      syncPanelDock();
      if (next && settings.focusPanel === true) lookup("btn-panel-close")?.focus();
    });
    return next;
  }

  function setGlassBlurEnabled(enabled) {
    const css = windowTarget.CSS;
    const supported = !!(css && typeof css.supports === "function" && (
      css.supports("backdrop-filter", "blur(1px)") || css.supports("-webkit-backdrop-filter", "blur(1px)")
    ));
    const active = enabled !== false && supported;
    body.setAttribute("data-glass-blur", active ? "available" : "off");
    return active;
  }

  /**
   * (audit finding F5). The frosting sits over a canvas
   * that changes every frame, so the compositor re-blurs it every frame in
   * every demo window. `?glass=off|on|<px>` is the user-facing lever over that
   * cost; the default lives in render-quality-levers.mjs and nowhere else.
   *
   * The radius travels through the existing `--osl-glass-blur` custom property
   * rather than a second rule, so `?glass=8` is a real intermediate arm and the
   * reduced-transparency / forced-colors overrides keep winning unchanged.
   */
  function applyGlassLever() {
    const search = (windowTarget.location && windowTarget.location.search) || "";
    const lever = resolveGlassLever(search);
    const root = documentTarget.documentElement;
    if (root && root.style && typeof root.style.setProperty === "function") {
      root.style.setProperty("--osl-glass-blur", `${lever.blur_px}px`);
    }
    const active = setGlassBlurEnabled(lever.mode === "on");
    body.setAttribute("data-glass-lever", lever.source === "query" ? String(lever.raw) : "default");
    glassLever = { ...lever, active };
    return glassLever;
  }

  function chromeSnapshot() {
    const rectangle = (element) => {
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return {
        left: Number(value.left.toFixed(3)),
        top: Number(value.top.toFixed(3)),
        right: Number(value.right.toFixed(3)),
        bottom: Number(value.bottom.toFixed(3)),
        width: Number(value.width.toFixed(3)),
        height: Number(value.height.toFixed(3)),
      };
    };
    const rail = documentTarget.querySelector("aside.rail");
    return {
      owner: controllerIdentity.owner,
      mounted,
      mount_count: mountCount,
      listener_count: listeners.length,
      open: !appRoot?.classList.contains("rail-collapsed"),
      size_mode: manualPanelSize ? "manual" : "auto",
      preferred_size: manualPanelSize ? { ...manualPanelSize } : null,
      menu: rectangle(documentTarget.querySelector("header.role-banner")),
      panel: rectangle(rail),
      canvas: rectangle(documentTarget.querySelector("#scene-mount > canvas")),
      viewport: { width: windowTarget.innerWidth, height: windowTarget.innerHeight },
      blur: body.getAttribute("data-glass-blur"),
      glass_lever: glassLever
        ? { mode: glassLever.mode, blur_px: glassLever.blur_px, source: glassLever.source, raw: glassLever.raw }
        : null,
      reduced_transparency: body.getAttribute("data-reduced-transparency") === "true",
      dock: body.getAttribute("data-panel-dock"),
    };
  }

  function chromeDriver() {
    return {
      owner: () => controllerIdentity,
      snapshot: chromeSnapshot,
      open: () => setPanelOpen(true),
      close: () => setPanelOpen(false),
      setSize: (width, height) => applyPanelSize({ width, height }),
      resetSize: () => applyPanelSize(null),
      setBlurEnabled: (enabled) => setGlassBlurEnabled(enabled),
      glassLever: () => (glassLever ? { ...glassLever } : null),
      applyGlassLever: () => applyGlassLever(),
      setReducedTransparency: (enabled) => {
        body.setAttribute("data-reduced-transparency", String(enabled === true));
        return enabled === true;
      },
    };
  }

  function wirePanelChrome() {
    wireRailResizer();
    wirePanelDrag();
    wirePanelGroups();
    wirePanelCards();
    wireActivityJournal();

    const rail = documentTarget.querySelector("aside.rail");
    const railToggle = lookup("btn-rail-toggle");
    if (railToggle && appRoot) {
      on(railToggle, "click", () => {
        setPanelOpen(appRoot.classList.contains("rail-collapsed"), { announce: true });
      });
    }
    const closeButton = lookup("btn-panel-close");
    if (closeButton) on(closeButton, "click", () => setPanelOpen(false, { announce: true }));
    if (rail) {
      on(rail, "keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        setPanelOpen(false, { announce: true });
      });
    }
    applyGlassLever();
    const reducedTransparencyQuery = typeof windowTarget.matchMedia === "function"
      ? windowTarget.matchMedia("(prefers-reduced-transparency: reduce)")
      : null;
    if (reducedTransparencyQuery) {
      const syncReducedTransparency = () => {
        body.setAttribute("data-reduced-transparency", String(reducedTransparencyQuery.matches));
      };
      syncReducedTransparency();
      on(reducedTransparencyQuery, "change", syncReducedTransparency);
    }
    setPanelOpen(true, { focusToggle: false });
    wirePortalSettingsModal();

    const mount = lookup("scene-mount");
    if (mount && ResizeObserverClass) {
      const observer = new ResizeObserverClass(() => {
        if (resizeFrame) return;
        resizeFrame = requestFrame(() => {
          resizeFrame = 0;
          resizeSceneSurfaces();
        });
      });
      observer.observe(mount);
      observers.push(observer);
    }
    syncPanelState();
  }


  function renderWowApiLog() {
    const el = lookup("wow-api-log");
    if (!el) return;
    const readerScrollTop = el.scrollTop;
    const wasAtTop = readerScrollTop === 0;
    const html = wowApiLog.length
      ? wowApiLog.slice(-WOW_API_LOG_RENDER_LIMIT).reverse().map((record) => {
          const okClass = record.ok ? "ok" : "bad";
          const methodClass = record.method === "POST" ? "post" : "get";
          const statusText = record.status ? String(record.status) : (record.ok ? "200" : "ERR");
          return `<li data-testid="wow-api-log-row" data-reconcile-key="wow-api-log-${record.__reconcileKey}" data-method="${wowEscape(record.method)}" data-path="${wowEscape(record.path)}" data-status="${wowEscape(statusText)}" data-schema="${wowEscape(record.schema)}">
        <span class="m ${methodClass}">${wowEscape(record.method)}</span>
        <span class="p">${wowEscape(record.path)}</span>
        <span class="s ${okClass}">${wowEscape(statusText)}</span>
        <span class="sc">${wowEscape(record.schema)}</span>
      </li>`;
        }).join("")
      : `<li class="wow-log-empty" data-testid="wow-api-log-empty" data-reconcile-key="wow-api-log-empty">no /wow requests recorded yet</li>`;
    reconcileKeyedHtml(el, html);
    el.scrollTop = wasAtTop ? 0 : readerScrollTop;
  }

  function currentDebug() {
    const cap = capabilities();
    return typeof cap.debugState === "function" ? cap.debugState() : null;
  }

  function recordWowApiRequest(detail) {
    if (!detail) return;
    wowApiLog.push({ ...detail, __reconcileKey: ++wowApiLogSequence });
    if (wowApiLog.length > WOW_API_LOG_MEMORY_LIMIT) {
      wowApiLog.splice(0, wowApiLog.length - WOW_API_LOG_MEMORY_LIMIT);
    }
    body.setAttribute("data-wow-api-last", `${detail.method} ${detail.path} ${detail.status}`);
    body.setAttribute("data-wow-api-request-count", String(wowApiLog.length));
    renderWowApiLog();
    recordActivity({
      message: `${detail.method || "GET"} ${detail.path || detail.url || "request"} → ${detail.status || (detail.ok ? "OK" : "ERR")}`,
      eventClass: "network",
      severity: detail.ok === false ? "warning" : "info",
      at: detail.at || undefined,
    });
    renderLiveContractSummary(currentDebug());
  }

  function wowLogHas(suffix, method) {
    return wowApiLog.some((record) =>
      (!method || record.method === method) && typeof record.path === "string" && record.path.indexOf(suffix) !== -1
    );
  }

  function renderWowJson(targetId, result, settings = {}) {
    const el = lookup(targetId);
    if (!el) return;
    const bad = settings.isError || (result && result.ok === false);
    el.className = "wow-json" + (bad ? " bad" : "");
    const value = result && typeof result === "object" && "json" in result ? result.json : result;
    const schema = result && result.schema ? result.schema : settings.schema || "";
    return presentationViewer.present(targetId, value, {
      label: settings.label || (targetId === "wow-presenter-result"
        ? "Web of Worlds · crossing API response"
        : `Web of Worlds · ${schema || "endpoint"} response`),
      method: settings.method || (targetId === "wow-presenter-result" ? "POST" : "GET"),
      path: result && result.url ? result.url : settings.path || "",
      status: result && result.status !== undefined ? `HTTP ${result.status}` : bad ? "error" : "current",
      schema,
      freshness: settings.freshness || "Current response already shown in this panel preview",
      state: bad ? "error" : "current",
      sourceKind: settings.sourceKind || String(schema).toLowerCase(),
    });
  }

  async function onWowChipClick(kind) {
    const cap = capabilities();
    if (typeof cap.apiFetchEndpoint !== "function") return null;
    const idEl = lookup("wow-id-input");
    const id = idEl ? idEl.value.trim() : "";
    const result = await cap.apiFetchEndpoint(kind, id);
    renderWowJson("wow-json-view", result, {
      isError: result.ok === false,
      method: "GET",
      sourceKind: kind,
    });
    return result;
  }

  function setWowArrivalEditFromPacket(packet) {
    const el = lookup("wow-arrival-position");
    if (!el) return;
    const position = packet && packet.target && Array.isArray(packet.target.arrival_position)
      ? packet.target.arrival_position
      : [];
    el.value = JSON.stringify(position);
  }

  function applyWowArrivalEdit() {
    if (!wowHeldPacket) return { ok: false, error: "no held packet" };
    const el = lookup("wow-arrival-position");
    if (!el) return { ok: false, error: "no editor" };
    let parsed;
    try { parsed = JSON.parse(el.value); }
    catch (error) { return { ok: false, error: `arrival_position is not valid JSON: ${error.message}` }; }
    if (!Array.isArray(parsed) || parsed.length < 3 || !parsed.every((value) => Number.isFinite(Number(value)))) {
      return { ok: false, error: "arrival_position must be a [x, y, z] number array" };
    }
    wowHeldPacket.target = wowHeldPacket.target || {};
    wowHeldPacket.target.arrival_position = parsed.map(Number);
    return { ok: true, arrival_position: wowHeldPacket.target.arrival_position };
  }

  async function onWowExitIntent() {
    const cap = capabilities();
    if (typeof cap.presenterExitIntent !== "function") return null;
    logLine("presenter: POST /portal/exit-intent (API demonstration; not the crossing)");
    const out = await cap.presenterExitIntent();
    wowHeldPacket = out.packet;
    setWowArrivalEditFromPacket(wowHeldPacket);
    renderWowJson("wow-presenter-result", { url: out.url, status: out.status, schema: "exit-intent packet", json: wowHeldPacket }, {
      method: "POST",
      sourceKind: "crossing",
    });
    const deliver = lookup("wow-btn-deliver");
    const wrong = lookup("wow-btn-wrongnode");
    if (deliver) deliver.disabled = false;
    if (wrong) wrong.disabled = false;
    return out;
  }

  async function onWowDeliverArrival(settings = {}) {
    const cap = capabilities();
    if (typeof cap.presenterDeliverArrival !== "function") return null;
    if (!wowHeldPacket) {
      renderWowJson("wow-presenter-result", { error: "press \"Exit via API\" first to obtain a packet" }, {
        isError: true,
        method: "POST",
        path: "client-held crossing packet",
        schema: "operator error",
        sourceKind: "crossing",
      });
      return null;
    }
    const edit = applyWowArrivalEdit();
    if (!edit.ok) {
      renderWowJson("wow-presenter-result", { error: edit.error }, {
        isError: true,
        method: "POST",
        path: "client-held crossing packet",
        schema: "operator error",
        sourceKind: "crossing",
      });
      return null;
    }
    logLine(settings.toWrongNode
      ? "presenter: POST /portal/arrival to the WRONG node (expect drift-guard 400)"
      : "presenter: POST /portal/arrival to the target (expect arrival_count +1)");
    const out = await cap.presenterDeliverArrival(wowHeldPacket, settings);
    renderWowJson("wow-presenter-result", {
      url: out.url,
      status: out.status,
      schema: settings.toWrongNode ? "drift-guard / contract validation" : "arrival applied",
      json: {
        delivered_to_endpoint: out.delivered_to_endpoint,
        wrong_node: out.wrong_node,
        arrival_count_before: out.arrival_count_before,
        arrival_count_after: out.arrival_count_after,
        arrival_count_delta: out.arrival_count_delta,
        response: out.response,
      },
    }, {
      isError: out.ok === false,
      method: "POST",
      sourceKind: "crossing",
    });
    return out;
  }

  function wireWowApiPanel() {
    if (apiMounted) return;
    apiMounted = true;
    const cap = capabilities();
    const info = typeof cap.apiPanelInfo === "function" ? cap.apiPanelInfo() : null;
    if (info) {
      const services = lookup("wow-services-line");
      if (services) services.textContent = info.services_line;
      const resolved = lookup("wow-resolved-line");
      if (resolved) {
        resolved.textContent = info.resolved_endpoints
          ? info.resolved_endpoints.line
          : "resolved endpoints → (root fabric not loaded)";
        resolved.setAttribute("data-resolved-from-services", String(!!(info.resolved_endpoints && info.resolved_endpoints.resolved_from_services)));
      }
    }
    const chips = lookup("wow-endpoint-chips");
    if (chips) {
      chips.querySelectorAll(".wow-chip").forEach((button) => {
        on(button, "click", () => { onWowChipClick(button.getAttribute("data-kind")); });
      });
    }
    const exit = lookup("wow-btn-exit");
    const deliver = lookup("wow-btn-deliver");
    const wrong = lookup("wow-btn-wrongnode");
    if (exit) on(exit, "click", () => { onWowExitIntent(); });
    if (deliver) on(deliver, "click", () => { onWowDeliverArrival({ toWrongNode: false }); });
    if (wrong) on(wrong, "click", () => { onWowDeliverArrival({ toWrongNode: true }); });
    renderWowApiLog();
    renderLiveContractSummary(currentDebug());
  }

  function refreshViewMatch(now) {
    const cap = capabilities();
    if (!isPlayer || typeof cap.verifyViewMatchesCamera !== "function" || cap.wowLocalWalk === true) return;
    // the only consumer of this probe is the
    // `wow-view-match-line` element. A hidden document paints nothing, so the
    // /wow/view read would be spent on a line nobody can read; the next
    // refresh after the document becomes visible restores it. Strict `=== true`
    // keeps hosts without a `hidden` property (the Node check harnesses) on the
    // pre-existing path.
    if (documentTarget?.hidden === true) return;
    if (viewMatchInFlight) return;
    const time = typeof now === "number" ? now : nowMs();
    if (time - lastViewMatchAt < 750) return;
    lastViewMatchAt = time;
    viewMatchInFlight = true;
    const token = lifecycleToken;
    Promise.resolve(cap.verifyViewMatchesCamera())
      .then((match) => {
        if (token !== lifecycleToken) return;
        const el = lookup("wow-view-match-line");
        if (!el) return;
        el.textContent = match
          ? match.ok
            ? "server View match → " + match.summary
            : "server View match → " + (match.summary || match.reason || "unavailable")
          : "server View match → (move to compare /wow/view/1 vs local camera)";
        if (match) el.setAttribute("data-view-match-ok", String(!!match.ok));
      })
      .catch(() => {})
      .finally(() => {
        if (token === lifecycleToken) viewMatchInFlight = false;
      });
  }

  function writeManifestPanel(manifest) {
    if (!lookup("std-um-manifest")) return;
    if (!manifest) {
      writeDebugText("std-um-manifest", "—");
      presentationViewer.clear("std-um-json-view", "Waiting for the current accepted manifest.");
      return;
    }
    const facetNames = (manifest.facets || []).map((facet) => facet.name || facet["@type"]).join(", ") || "none";
    const pointerCount = (manifest.pointers || []).length;
    const verified = manifest.__signature_verified ? "sig✓" : "sig?";
    writeDebugText("std-um-manifest",
      `v0.4 emitted · ${verified} · facets ${facetNames} · ${pointerCount} pointers`
    );
    presentationViewer.present("std-um-json-view", manifest, {
      label: "Universal Manifest · current panel manifest",
      path: "Universal Manifest live state",
      schema: "bounded local um:Manifest v0.4 projection",
      status: manifest.__signature_verified ? "signature verified" : "signature pending",
      freshness: "Current accepted in-memory manifest already represented by this panel",
      state: "current",
      sourceKind: "manifest",
    });
  }

  function emitManifestForPanel(debug, avatar, items) {
    if (!avatar || typeof buildAndSignManifest !== "function") return;
    const continuityId = avatar.continuity_id || null;
    const handoffId =
      (debug && debug.player_handoff_profile && debug.player_handoff_profile.iwps_query_teleport
        ? debug.player_handoff_profile.iwps_query_teleport.teleportId
        : null) ||
      (debug && debug.last_handoff_payload ? debug.last_handoff_payload.handoff_id : null) ||
      null;
    const key = `${continuityId || ""}:${handoffId || ""}`;
    if (key === lastManifestKey) {
      writeManifestPanel(lastManifest);
      return;
    }
    lastManifestKey = key;
    const nav = debug && debug.navigator ? debug.navigator : null;
    const state = {
      continuityId,
      handoffId,
      sourceLocationId: nav && nav.root_fabric ? nav.root_fabric.container || null : null,
      targetLocationId: nav && Array.isArray(nav.fabrics_loaded) ? nav.fabrics_loaded.slice(-1)[0] || null : null,
      avatar: makeAvatarDefinition({
        avatarId: avatar.avatar_id || "avatar",
        variant: avatar.avatar_variant || "default",
        displayName: avatar.display_name || null,
        equipmentProfile: debug && debug.equipment_status ? debug.equipment_status.profile || null : null,
        equippedItems: Array.isArray(items) ? items : [],
        poseRef: "last_handoff_payload.avatar_context.geopose_shaped_pose",
      }),
    };
    const iqt = debug && debug.player_handoff_profile ? debug.player_handoff_profile.iwps_query_teleport : null;
    const destinationUrl = iqt && iqt.teleport ? iqt.teleport.destinationUrl : null;
    if (destinationUrl && typeof makeLoadingPointer === "function") {
      state.loading = makeLoadingPointer({
        target: destinationUrl,
        pointerId: `loading-${handoffId || continuityId || "crossing"}`,
        label: "destination loading target (IWPS destination URL)",
      });
    }
    try {
      const destination = handoffId ? getDestinationLoadingContent() : null;
      if (destination && destination.content && typeof buildLoadingPointersForManifest === "function") {
        const pointers = buildLoadingPointersForManifest(destination.content, {
          handoffId: handoffId || continuityId || "crossing",
          destinationBase: destination.base,
        });
        if (pointers.length > 0) state.loadingPointers = pointers;
      }
    } catch {}
    if (nav) state.rp1 = nav;
    const token = lifecycleToken;
    Promise.resolve(buildAndSignManifest(state))
      .then(async ({ manifest }) => {
        if (token !== lifecycleToken) return;
        manifest.__signature_verified = typeof verifyManifestSignature === "function"
          ? await Promise.resolve(verifyManifestSignature(manifest)).catch(() => false)
          : false;
        if (token !== lifecycleToken) return;
        lastManifest = manifest;
        writeManifestPanel(manifest);
      })
      .catch(() => {});
  }

  function writeSigningStatus(debug) {
    if (!lookup("std-um-signing")) return;
    const signing = debug && debug.um_signing ? debug.um_signing : null;
    const exit = signing && signing.signed_on_exit ? signing.signed_on_exit : null;
    const arrival = signing && signing.verified_on_arrival ? signing.verified_on_arrival : null;
    if (!exit && !arrival) {
      writeDebugText("std-um-signing", "waiting · signs on exit, verifies on arrival");
      return;
    }
    const exitLine = exit && exit.signed
      ? `signed on exit (${exit.signature_profile || "Profile A"})`
      : "not signed on exit";
    const arrivalLine = !arrival || arrival.present === false || arrival.verified == null
      ? "no signed manifest verified on this side yet"
      : arrival.verified === true
        ? `verified on arrival: true (subject ${arrival.did_subject || "?"})`
        : `verified on arrival: FALSE — ${arrival.reason || "verification failed"}`;
    writeDebugText("std-um-signing", `${exitLine} · ${arrivalLine}`);
  }

  function writeIdentityStatus(debug) {
    const el = lookup("std-um-identity");
    if (!el) return;
    const identity = debug && debug.um_identity ? debug.um_identity : null;
    if (!identity || identity.present === false) {
      writeDebugText("std-um-identity", "not present or not verified");
      el.className = "v std-false";
      return;
    }
    const name = identity.name || "—";
    const line = identity.verified === true
      ? `verified · ${name} · ${identity.algorithm || "Ed25519"}/${identity.canonicalization || "JCS-RFC8785"}`
      : `unverified · ${name} · ${identity.reason || "no valid signature"}`;
    writeDebugText("std-um-identity", line);
    el.className = identity.verified === true ? "v std-true" : "v std-false";
  }

  function renderStandardUM(debug) {
    if (!lookup("std-um-card")) return;
    const avatar = debug && debug.avatar ? debug.avatar : null;
    const equipment = debug && debug.equipment_status ? debug.equipment_status : null;
    const items = avatar && Array.isArray(avatar.equippedItems)
      ? avatar.equippedItems
      : equipment && Array.isArray(equipment.items) ? equipment.items : [];
    writeDebugText("std-um-subject", avatar ? `${avatar.avatar_id || "—"} · ${avatar.continuity_id || "—"}` : "—");
    writeDebugText("std-um-name", avatar ? avatar.display_name || "—" : "—");
    writeDebugText("std-um-facets", "avatar_equipment · pose · continuity");
    writeDebugText("std-um-items", avatar || equipment ? String(items.length) : "—");
    writeDebugText("std-um-continuity", avatar && avatar.continuity_id ? `yes · ${avatar.continuity_id}` : "—");
    try { emitManifestForPanel(debug, avatar, items); } catch {}
    try { writeSigningStatus(debug); } catch {}
    try { writeIdentityStatus(debug); } catch {}
  }

  function displayIwpsPath(url) {
    const value = String(url || "");
    const match = value.match(/^https?:\/\/[^/]+(\/.*)$/);
    return match ? match[1] : value;
  }

  function renderStandardIWPS(debug) {
    if (!lookup("std-iwps-card")) return;
    const profile = debug && debug.player_handoff_profile ? debug.player_handoff_profile : null;
    const iqt = profile && profile.iwps_query_teleport ? profile.iwps_query_teleport : null;
    const queryPath = iqt && iqt.query && iqt.query.portalUrl ? iqt.query.portalUrl : "/portal/exit-intent";
    const teleportPath = iqt && iqt.teleport && iqt.teleport.destinationUrl ? iqt.teleport.destinationUrl : "/portal/arrival";
    writeDebugText("std-iwps-endpoints",
      `POST ${displayIwpsPath(queryPath)} → POST ${displayIwpsPath(teleportPath)}`
    );
    writeDebugText("std-iwps-exit", iqt && iqt.query
      ? `sent · ${iqt.query.portalUrl || displayIwpsPath(queryPath)}`
      : "awaiting a crossing");
    writeDebugText("std-iwps-arrival", iqt && iqt.teleport
      ? `sent · ${iqt.teleport.destinationUrl || displayIwpsPath(teleportPath)}`
      : "awaiting a crossing");
    writeDebugText("std-iwps-pose", iqt
      ? `${iqt.teleportId || debug.handoff_id || "—"} · ${iqt.teleport ? "teleport sent" : "query sent"}`
      : "—");
  }

  function renderRp1FailClosed(debug) {
    if (!lookup("rp1-fc-mode")) return;
    const state = debug && debug.rp1_fail_closed ? debug.rp1_fail_closed : null;
    const mode = state ? state.demo_mode : "off";
    writeDebugText("rp1-fc-mode", mode === "off"
      ? "allow · normal crossing"
      : mode === "stale-attachment"
        ? "deny · stale attachment"
        : "deny · revoked session");
    const wrap = lookup("rp1-failclosed-modes");
    if (wrap) {
      wrap.querySelectorAll("button[data-mode]").forEach((button) => {
        button.classList.toggle("primary", button.getAttribute("data-mode") === mode);
      });
    }
    const receipt = state ? state.last_receipt : null;
    if (!receipt) writeDebugText("rp1-fc-receipt", "no attempt yet");
    else if (receipt.decision === "allow") writeDebugText("rp1-fc-receipt", `accepted · ${receipt.reasons && receipt.reasons[0] || "checks passed"}`);
    else if (receipt.decision === "deny") writeDebugText("rp1-fc-receipt", `rejected · ${receipt.action || "default-deny"}`);
    else writeDebugText("rp1-fc-receipt", `${receipt.decision || "—"} (${receipt.reasons && receipt.reasons[0] || ""})`);
    const descriptor = state ? state.descriptor : null;
    writeDebugText("rp1-fc-flag", descriptor ? `fail closed: ${descriptor.fail_closed_conformance}` : "—");
  }

  function wireRp1FailClosed() {
    const wrap = lookup("rp1-failclosed-modes");
    if (!wrap) return;
    wrap.querySelectorAll("button[data-mode]").forEach((button) => {
      on(button, "click", () => {
        const cap = capabilities();
        if (typeof cap.setRp1FailClosedDemoMode === "function") {
          cap.setRp1FailClosedDemoMode(button.getAttribute("data-mode"));
        }
      });
    });
  }

  function renderStandardFabric(debug) {
    if (!lookup("std-fabric-card")) return;
    const nav = debug && debug.navigator ? debug.navigator : null;
    const msf = debug && debug.msf ? debug.msf : null;
    const root = nav && nav.root_fabric ? nav.root_fabric : null;
    const jws = msf && msf.jws ? msf.jws : root && root.jws ? root.jws : null;
    const moduleRun = debug && debug.module_run ? debug.module_run : null;
    const readVerified = !!(
      msf && msf.result === "VERIFIED" &&
      root && root.status === "verified" && root.signed === true &&
      jws && jws.signature_verified === true && jws.chain_verified === true && jws.validity_ok === true
    );
    const servedInSession = !!(readVerified && typeof root.url === "string" && root.url.length > 0);
    const importedSubsetRan = !!(
      readVerified && msf.wasm_run === true &&
      moduleRun && moduleRun.ran === true && moduleRun.hash_ok === true
    );
    writeDebugText("std-fabric-context", nav ? nav.context_id || "—" : "—");
    writeDebugText("std-fabric-loaded", nav
      ? `${nav.fabrics_loaded_count || 0} in one context: ${(nav.fabrics_loaded || []).join(", ") || "—"}`
      : "—");
    writeDebugText("std-fabric-root", nav && nav.root_fabric
      ? `${nav.root_fabric.container || nav.root_fabric.url || "—"} · ${nav.root_fabric.status || "—"}`
      : "—");
    writeDebugText("std-fabric-child", nav && nav.child_fabric
      ? `${nav.child_fabric.container || nav.child_fabric.url || "—"} · ${nav.child_fabric.status || "—"}`
      : "—");
    const cap = capabilities();
    const info = typeof cap.apiPanelInfo === "function" ? cap.apiPanelInfo() : null;
    const serviceCount = info && Array.isArray(info.services) ? info.services.length : 0;
    writeDebugText("std-fabric-services", info
      ? serviceCount ? `${serviceCount} endpoints advertised (Web of Worlds surface)` : "(root fabric not loaded)"
      : "—");
    writeDebugText("std-fabric-portal", nav && nav.portal_attachment
      ? `${nav.portal_attachment.node_id || "?"} → ${nav.portal_attachment.sReference || "—"}`
      : "—");
    writeDebugText("std-fabric-trust", root && (root.status === "loaded" || root.status === "verified")
      ? `${root.format || "plain-json"} · ${root.signed ? `SIGNED (verified: ${jws && jws.anchor ? jws.anchor : "shipped test anchor"})` : "UNSIGNED (labeled)"}`
      : "—");
    writeDebugText("std-fabric-reads-msf", readVerified
      ? "verified · signed .msf"
      : "not verified in this session");
    const readRow = lookup("std-fabric-reads-msf");
    if (readRow) readRow.className = readVerified ? "v std-true" : "v std-false";
    writeDebugText("std-fabric-serves-msf", servedInSession
      ? "retrieved and verified"
      : "not observed in this session");
    const serveRow = lookup("std-fabric-serves-msf");
    if (serveRow) serveRow.className = servedInSession ? "v std-true" : "v std-false";
    writeDebugText("std-fabric-abi", importedSubsetRan
      ? "executed · hash verified"
      : "not run in this session");
    const runRow = lookup("std-fabric-abi");
    if (runRow) runRow.className = importedSubsetRan ? "v std-true" : "v std-false";
    try { renderRp1FailClosed(debug); } catch {}
  }

  function renderStandardTeleportXR(debug) {
    if (!lookup("std-txr-renderer")) return;
    const cap = capabilities();
    const boundary = typeof cap.claimBoundary === "function" ? cap.claimBoundary() : null;
    const validation = debug && debug.proof_boundary ? debug.proof_boundary : boundary;
    writeDebugBool("std-txr-native", !!(validation && validation.native_teleportxr_teleport === true));
    writeDebugBool("std-txr-render", !!(validation && validation.first_party_teleportxr_browser_rendering === true));
    writeDebugText("std-txr-renderer", `${cap.rendererKind || "three.js"} · application renderer`);
  }

  function renderStandardsViews(debug) {
    const state = debug || currentDebug();
    if (!state) return;
    renderStandardUM(state);
    renderStandardIWPS(state);
    renderStandardFabric(state);
    renderStandardTeleportXR(state);
  }

  function mount(settings = {}) {
    attachApiEventListener();
    if (!mounted) {
      mounted = true;
      mountCount += 1;
      presentationViewer.mount();
      wirePanelChrome();
      wireRp1FailClosed();
    }
    if (settings.apiPanel === true) wireWowApiPanel();
    if (settings.standards === true && settings.debug) renderStandardsViews(settings.debug);
    renderLiveContractSummary(settings.debug || currentDebug());
    return debug();
  }

  function refresh(debugState) {
    renderStandardsViews(debugState);
    renderLiveContractSummary(debugState);
    return debug();
  }

  function wowApiDriver() {
    return {
      log: () => wowApiLog.slice(),
      logHas: (suffix, method) => wowLogHas(suffix, method),
      info: () => {
        const cap = capabilities();
        return typeof cap.apiPanelInfo === "function" ? cap.apiPanelInfo() : null;
      },
      fetchEndpoint: (kind, id) => {
        const cap = capabilities();
        if (id != null) {
          const input = lookup("wow-id-input");
          if (input) input.value = String(id);
        }
        return onWowChipClick(kind) || (typeof cap.apiFetchEndpoint === "function" ? cap.apiFetchEndpoint(kind, id) : null);
      },
      exitIntent: () => onWowExitIntent(),
      setArrivalPosition: (position) => {
        const el = lookup("wow-arrival-position");
        if (el) el.value = JSON.stringify(position);
        return applyWowArrivalEdit();
      },
      deliverArrival: (settings) => onWowDeliverArrival(settings || { toWrongNode: false }),
      heldPacket: () => wowHeldPacket,
      resolvedEndpoints: () => {
        const cap = capabilities();
        const info = typeof cap.apiPanelInfo === "function" ? cap.apiPanelInfo() : null;
        return info ? info.resolved_endpoints : null;
      },
      verifyView: () => {
        const cap = capabilities();
        return typeof cap.verifyViewMatchesCamera === "function"
          ? cap.verifyViewMatchesCamera()
          : Promise.resolve(null);
      },
      presentation: () => presentationViewer,
    };
  }

  function debug() {
    return {
      mounted,
      api_mounted: apiMounted,
      api_request_count: wowApiLog.length,
      api_last: wowApiLog.length ? { ...wowApiLog[wowApiLog.length - 1] } : null,
      held_packet: wowHeldPacket,
      group_count: Number(body.getAttribute("data-panel-group-count") || 0),
      visible_card_count: Number(body.getAttribute("data-panel-card-count") || 0),
      collapsed_card_count: Number(body.getAttribute("data-panel-collapsed-card-count") || 0),
      activity_count: activityJournal.length,
      rail_width: body.getAttribute("data-rail-width"),
      panel_height: body.getAttribute("data-panel-height"),
      panel_open: body.getAttribute("data-panel-open") === "true",
      panel_size_mode: body.getAttribute("data-panel-size-mode"),
      mount_count: mountCount,
      listener_count: listeners.length,
      manifest_key: lastManifestKey,
      manifest_emitted: !!lastManifest,
    };
  }

  function dispose() {
    lifecycleToken += 1;
    presentationViewer.dispose();
    while (listeners.length) {
      const remove = listeners.pop();
      try { remove(); } catch {}
    }
    while (observers.length) {
      const observer = observers.pop();
      try { observer.disconnect(); } catch {}
    }
    if (railFrame) { cancelFrame(railFrame); railFrame = 0; }
    if (resizeFrame) { cancelFrame(resizeFrame); resizeFrame = 0; }
    for (const frame of ownedFrames) cancelFrame(frame);
    ownedFrames.clear();
    body.removeAttribute("data-rail-dragging");
    body.removeAttribute("data-panel-dragging");
    for (const attribute of [
      "data-panel-group-count",
      "data-panel-card-count",
      "data-panel-collapsed-card-count",
      "data-panel-group-standards-expanded",
      "data-panel-group-runtime-expanded",
      "data-activity-journal-count",
      "data-activity-journal-filter",
      "data-activity-journal-order",
      "data-wow-api-last",
      "data-wow-api-request-count",
      "data-panel-open",
      "data-panel-dock",
      "data-panel-size-mode",
      "data-panel-height",
      "data-glass-blur",
      "data-glass-lever",
      "data-reduced-transparency",
    ]) body.removeAttribute(attribute);
    for (const property of ["--rail-w", "--rail-h", "--rail-top", "--rail-left", "--rail-right"]) {
      body.style.removeProperty(property);
    }
    const documentRoot = documentTarget.documentElement;
    if (documentRoot && documentRoot.style && typeof documentRoot.style.removeProperty === "function") {
      documentRoot.style.removeProperty("--osl-glass-blur");
    }
    glassLever = null;
    const handle = lookup("rail-resizer");
    if (handle) handle.removeAttribute("data-dragging");
    const heightHandle = lookup("panel-height-resizer");
    if (heightHandle) heightHandle.removeAttribute("data-dragging");
    mounted = false;
    apiMounted = false;
    viewMatchInFlight = false;
  }

  const apiEventListener = (event) => recordWowApiRequest(event.detail);
  function attachApiEventListener() {
    if (apiEventAttached || !apiEvents || typeof apiEvents.addEventListener !== "function") return;
    apiEvents.addEventListener("wow-api-request", apiEventListener);
    apiEventAttached = true;
    listeners.push(() => {
      apiEvents.removeEventListener("wow-api-request", apiEventListener);
      apiEventAttached = false;
    });
  }
  attachApiEventListener();

  return {
    mount,
    refresh,
    refreshViewMatch,
    renderStandardsViews,
    applyRailWidth,
    applyPanelSize,
    wowApiDriver,
    groupDriver,
    chromeDriver,
    recordActivity,
    debug,
    presentationDriver: () => presentationViewer,
    dispose,
  };
}
