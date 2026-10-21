const ACTIVATION_KEYS = new Set(["Enter", " "]);

function portalKey(portal) {
  if (!portal || typeof portal !== "object") return null;
  return portal.string_portal_id || portal.portal_id || null;
}

function destinationIdentity(portal) {
  if (!portal || typeof portal !== "object") return null;
  return portal.target_location_id || portal.target_world_id || portal.target_fixture?.spatial_id || null;
}

function fallbackLabel(identity) {
  return String(identity || "destination")
    .replace(/^location-/, "Location ")
    .replace(/^world-/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function orderedPortalDescriptors(world) {
  if (!world || typeof world !== "object") return [];
  if (Array.isArray(world.portals)) {
    return world.portals.filter(Boolean);
  }
  if (world.portals && typeof world.portals === "object") {
    return Object.entries(world.portals)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, portal]) => portal)
      .filter(Boolean);
  }
  return world.portal ? [world.portal] : [];
}

function portalStatusByKey(debug) {
  const controls = debug && debug.controls ? debug.controls : {};
  const statuses = Array.isArray(controls.portals) ? controls.portals : [];
  return new Map(statuses.filter(Boolean).map((status) => [status.portal_id, status]));
}

function unavailableStatus(label, reason) {
  return {
    kind: "unavailable",
    status: `${label} unavailable — ${reason}`,
    actionLabel: `Hear why ${label} is unavailable`,
  };
}

function readinessForPortal({ portal, status, controls, connectionState, isPlayer }) {
  const label = portal.label || fallbackLabel(destinationIdentity(portal));
  if (!isPlayer) return unavailableStatus(label, "player navigation is not available in this observer view");
  if (["disconnected", "unavailable", "error"].includes(connectionState)) {
    return unavailableStatus(label, "the current live world is unavailable");
  }
  if (connectionState === "refused") {
    return {
      kind: "refused",
      status: `${label} refused — the current runtime or trust policy refused navigation`,
      actionLabel: `Hear why ${label} was refused`,
    };
  }
  if (status && status.entry_side_allowed === false) {
    return {
      kind: "refused",
      status: `${label} refused from this side of the portal`,
      actionLabel: `Hear why ${label} is refused from this side`,
    };
  }
  const focused = status?.is_focus === true || controls.portal_focus_portal_id === portalKey(portal);
  const blocker = focused ? controls.portal_ready_blocker : null;
  if (blocker) {
    const refused = /deny|refus|policy|trust|entry[_ -]?side/i.test(String(blocker));
    return {
      kind: refused ? "refused" : "unavailable",
      status: `${label} ${refused ? "refused" : "unavailable"} — ${String(blocker).replace(/_/g, " ")}`,
      actionLabel: `Hear why ${label} is ${refused ? "refused" : "unavailable"}`,
    };
  }
  if (focused) {
    return {
      kind: "ready",
      status: `${label} is the focused portal — activation arms it; crossing has not completed`,
      actionLabel: `Activate the focused portal to ${label}`,
    };
  }
  return {
    kind: "wayfinding",
    status: `${label} is available — move to this portal to make it the spatial focus`,
    actionLabel: `Wayfind to ${label}`,
  };
}

/** Derive the semantic surface only from the current world and its portal descriptors. */
export function deriveSemanticDestinations({ world, debug, connectionState = "live", isPlayer = true } = {}) {
  const controls = debug && debug.controls ? debug.controls : {};
  const statuses = portalStatusByKey(debug);
  const currentWorld = {
    identity: world?.location_id || world?.world_id || null,
    label: world?.title || fallbackLabel(world?.location_id || world?.world_id || "current world"),
    status: connectionState === "live" ? "current live world" : `current world · ${connectionState}`,
  };
  const destinations = orderedPortalDescriptors(world).map((portal) => {
    const key = portalKey(portal);
    const identity = destinationIdentity(portal);
    const readiness = readinessForPortal({
      portal,
      status: statuses.get(key),
      controls,
      connectionState,
      isPlayer,
    });
    return {
      key,
      portalId: key,
      identity,
      label: portal.label || fallbackLabel(identity),
      status: readiness.status,
      statusKind: readiness.kind,
      actionLabel: readiness.actionLabel,
      transition: portal.traversal?.transition || null,
      isFocused: statuses.get(key)?.is_focus === true || controls.portal_focus_portal_id === key,
    };
  });
  return { currentWorld, destinations };
}

export function createSemanticDestinationsController({
  lookup,
  createElement,
  documentTarget,
  eventTarget,
  getSnapshot,
  activateFocusedPortal,
  isTypingTarget,
  logger = () => {},
}) {
  const requiredFunctions = { lookup, createElement, getSnapshot, activateFocusedPortal, isTypingTarget };
  for (const [name, value] of Object.entries(requiredFunctions)) {
    if (typeof value !== "function") throw new TypeError(`semantic destinations controller requires ${name}`);
  }

  const mountedListeners = [];
  const destinationListeners = [];
  let mounted = false;
  let openState = false;
  let model = deriveSemanticDestinations(getSnapshot());
  let previousWorldIdentity = model.currentWorld.identity;
  let lastAnnouncement = "";

  function listen(target, type, handler) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, handler);
    mountedListeners.push([target, type, handler]);
  }

  function clearDestinationListeners() {
    for (const [target, type, handler] of destinationListeners.splice(0)) {
      target.removeEventListener(type, handler);
    }
  }

  function announce(message) {
    const next = String(message || "").trim();
    if (!next || next === lastAnnouncement) return;
    lastAnnouncement = next;
    const status = lookup("semantic-destinations-status");
    if (status) status.textContent = next;
  }

  function currentWorldAnnouncement(changed) {
    const label = model.currentWorld.label || "Current world";
    return changed ? `Current world changed to ${label}.` : `Current world: ${label}.`;
  }

  function destinationButton(key) {
    const list = lookup("semantic-destinations-list");
    if (!list) return null;
    return Array.from(list.children || []).find((child) => child?.dataset?.destinationKey === key) || null;
  }

  async function activate(key) {
    const destination = model.destinations.find((entry) => entry.key === key);
    if (!destination) return { ok: false, kind: "missing", crossing: false };
    if (destination.statusKind === "unavailable" || destination.statusKind === "refused") {
      announce(`${destination.status}. Focus remains on ${destination.label}.`);
      destinationButton(key)?.focus?.();
      return { ok: false, kind: destination.statusKind, crossing: false };
    }
    if (!destination.isFocused) {
      announce(`Wayfinding to ${destination.label}: move through ${model.currentWorld.label} until this portal has spatial focus. No crossing occurred.`);
      return { ok: true, kind: "wayfinding", crossing: false };
    }
    try {
      await activateFocusedPortal(destination);
      announce(`Portal activated for ${destination.label}. Crossing has not completed; move through the focused portal to continue.`);
      return { ok: true, kind: "portal_activation", crossing: false };
    } catch (error) {
      logger(`semantic destination activation refused: ${error?.message || String(error)}`);
      announce(`${destination.label} activation was refused. Focus remains on this destination; no crossing occurred.`);
      destinationButton(key)?.focus?.();
      return { ok: false, kind: "refused", crossing: false };
    }
  }

  function wireDestinationButton(button, destination) {
    const click = () => { void activate(destination.key); };
    const keydown = (event) => {
      if (!ACTIVATION_KEYS.has(event.key)) return;
      event.preventDefault?.();
      void activate(destination.key);
    };
    button.addEventListener("click", click);
    button.addEventListener("keydown", keydown);
    destinationListeners.push([button, "click", click], [button, "keydown", keydown]);
  }

  function render({ forceFocus = false, worldChanged = false } = {}) {
    const panel = lookup("semantic-destinations-panel");
    const toggle = lookup("btn-semantic-destinations");
    const current = lookup("semantic-current-world");
    const list = lookup("semantic-destinations-list");
    if (!panel || !list) return;
    const activeElement = documentTarget?.activeElement || null;
    const focusedKey = activeElement?.dataset?.destinationKey || null;
    const hadDestinationFocus = !!focusedKey;
    panel.hidden = !openState;
    toggle?.setAttribute?.("aria-expanded", String(openState));
    if (current) current.textContent = `${model.currentWorld.label} · ${model.currentWorld.status}`;
    clearDestinationListeners();
    list.textContent = "";
    if (!model.destinations.length) {
      const empty = createElement("p");
      empty.className = "semantic-destination-empty";
      empty.textContent = "No portal destinations are available from the current world.";
      list.appendChild(empty);
    } else {
      for (const destination of model.destinations) {
        const button = createElement("button");
        button.type = "button";
        button.className = `semantic-destination semantic-destination-${destination.statusKind}`;
        button.dataset.destinationKey = destination.key;
        button.dataset.destinationIdentity = destination.identity || "";
        button.setAttribute("data-testid", `semantic-destination-${destination.key}`);
        button.setAttribute("aria-disabled", String(["unavailable", "refused"].includes(destination.statusKind)));
        button.setAttribute("aria-label", `${destination.actionLabel}. ${destination.status}.`);
        const label = createElement("strong");
        label.textContent = destination.label;
        const status = createElement("span");
        status.textContent = destination.status;
        button.append(label, status);
        wireDestinationButton(button, destination);
        list.appendChild(button);
      }
    }
    if (!openState || (!forceFocus && !hadDestinationFocus)) return;
    const preferredKey = focusedKey && model.destinations.some((entry) => entry.key === focusedKey)
      ? focusedKey
      : worldChanged
        ? model.destinations.find((entry) => entry.identity === previousWorldIdentity)?.key || null
        : null;
    const target = destinationButton(preferredKey) || destinationButton(model.destinations[0]?.key);
    target?.focus?.();
  }

  function update(snapshot = getSnapshot()) {
    const next = deriveSemanticDestinations(snapshot);
    const nextWorldIdentity = next.currentWorld.identity;
    const worldChanged = previousWorldIdentity !== null && nextWorldIdentity !== previousWorldIdentity;
    model = next;
    render({ worldChanged });
    if (worldChanged || !lastAnnouncement) announce(currentWorldAnnouncement(worldChanged));
    previousWorldIdentity = nextWorldIdentity;
    return snapshotModel();
  }

  function open() {
    openState = true;
    update();
    render({ forceFocus: true });
  }

  function close() {
    openState = false;
    render();
    lookup("btn-semantic-destinations")?.focus?.();
  }

  function mount() {
    if (mounted) return api;
    mounted = true;
    listen(lookup("btn-semantic-destinations"), "click", () => (openState ? close() : open()));
    listen(lookup("btn-semantic-destinations-close"), "click", close);
    listen(eventTarget, "keydown", (event) => {
      if (event.key === "Escape" && openState && !isTypingTarget(event.target)) close();
    });
    update();
    return api;
  }

  function dispose() {
    for (const [target, type, handler] of mountedListeners.splice(0)) {
      target.removeEventListener(type, handler);
    }
    clearDestinationListeners();
    mounted = false;
    openState = false;
  }

  function snapshotModel() {
    return JSON.parse(JSON.stringify({ ...model, open: openState, announcement: lastAnnouncement }));
  }

  const api = { mount, dispose, update, open, close, activate, snapshot: snapshotModel, isOpen: () => openState };
  return api;
}
