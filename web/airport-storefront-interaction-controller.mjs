const CATALOG_SCHEMA = "osl.airport-storefront-catalog.v1";
const AIRPORT_LOCATION_ID = "location-airport";
const MOVEMENT_CODES = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight",
]);

export const AIRPORT_SHOPPING_SESSION_RULE = Object.freeze({
  persistence: "airport_session_only",
  airport_exit: "close interaction and clear local-demo pickup list",
  airport_reentry: "start with an empty local-demo pickup list",
  claim_boundary: "no order, payment, stock reservation, fulfillment, or completed purchase",
});

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function position3(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const position = value.slice(0, 3).map(Number);
  return position.every(Number.isFinite) ? position : null;
}

function normalizeCatalogItem(raw, index) {
  const item = raw && typeof raw === "object" ? raw : {};
  const normalized = {
    item_id: nonEmptyText(item.item_id),
    name: nonEmptyText(item.name),
    summary: nonEmptyText(item.summary),
    detail: nonEmptyText(item.detail),
    pickup_note: nonEmptyText(item.pickup_note),
  };
  const missing = Object.entries(normalized)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  return missing.length
    ? { ok: false, reason: `catalog item ${index + 1} is missing ${missing.join(", ")}` }
    : { ok: true, item: Object.freeze(normalized) };
}

function normalizeStorefront(raw, index) {
  const store = raw && typeof raw === "object" ? raw : {};
  const nodeId = nonEmptyText(store.node_id) || `malformed-store-${index + 1}`;
  const label = nonEmptyText(store.label) || "Unnamed airport storefront";
  const category = nonEmptyText(store.category) || "unknown";
  const position = position3(store.position_m);
  const radius = Number(store.interaction_radius_m);
  const availability = store.availability === "available" || store.availability === "unavailable"
    ? store.availability
    : null;
  const errors = [];
  if (!nonEmptyText(store.node_id)) errors.push("node_id is missing");
  if (!nonEmptyText(store.label)) errors.push("label is missing");
  if (!nonEmptyText(store.category)) errors.push("category is missing");
  if (!position) errors.push("position_m must contain three finite numbers");
  if (!Number.isFinite(radius) || radius <= 0) errors.push("interaction_radius_m must be positive");
  if (store.catalog_schema !== CATALOG_SCHEMA) errors.push(`catalog_schema must be ${CATALOG_SCHEMA}`);
  if (!availability) errors.push("availability must be available or unavailable");
  if (!Array.isArray(store.catalog)) errors.push("catalog must be an array");

  const items = [];
  if (Array.isArray(store.catalog)) {
    for (let itemIndex = 0; itemIndex < store.catalog.length; itemIndex += 1) {
      const candidate = normalizeCatalogItem(store.catalog[itemIndex], itemIndex);
      if (!candidate.ok) errors.push(candidate.reason);
      else items.push(candidate.item);
    }
    const ids = items.map((item) => item.item_id);
    if (new Set(ids).size !== ids.length) errors.push("catalog item_id values must be unique");
  }

  let catalogState = "ready";
  if (errors.length) catalogState = "malformed";
  else if (availability === "unavailable") catalogState = "unavailable";
  else if (items.length === 0) catalogState = "empty";

  return {
    node_id: nodeId,
    label,
    category,
    sign: nonEmptyText(store.sign) || label,
    position_m: position || [0, 0, 0],
    interaction_radius_m: Number.isFinite(radius) && radius > 0 ? radius : 0,
    availability: availability || "malformed",
    availability_reason: nonEmptyText(store.availability_reason),
    pickup_label: nonEmptyText(store.pickup_label) || `${label} demo pickup point`,
    claim_boundary: nonEmptyText(store.claim_boundary) || AIRPORT_SHOPPING_SESSION_RULE.claim_boundary,
    catalog_state: catalogState,
    catalog_errors: errors,
    items,
  };
}

/**
 * Validate the airport scene summary without letting one bad storefront break
 * traversal or every other catalog.
 */
export function createAirportStorefrontCatalogContract(airportTerminal) {
  const rawStores = airportTerminal && Array.isArray(airportTerminal.storefronts)
    ? airportTerminal.storefronts
    : null;
  if (!rawStores) {
    return Object.freeze({
      ok: false,
      source: "airport_terminal.storefronts",
      reason: "airport storefront metadata is missing",
      stores: Object.freeze([]),
      ready_count: 0,
    });
  }
  const stores = rawStores.map(normalizeStorefront);
  const counts = new Map();
  for (const store of stores) counts.set(store.node_id, (counts.get(store.node_id) || 0) + 1);
  for (const store of stores) {
    if ((counts.get(store.node_id) || 0) > 1 && !store.catalog_errors.includes("node_id must be unique")) {
      store.catalog_errors.push("node_id must be unique");
      store.catalog_state = "malformed";
    }
  }
  return Object.freeze({
    ok: true,
    source: "airport_terminal.storefronts",
    reason: null,
    stores: Object.freeze(stores.map((store) => Object.freeze({
      ...store,
      position_m: Object.freeze(store.position_m.slice()),
      catalog_errors: Object.freeze(store.catalog_errors.slice()),
      items: Object.freeze(store.items.slice()),
    }))),
    ready_count: stores.filter((store) => store.catalog_state === "ready").length,
  });
}

function planarDistance(position, target) {
  if (!position3(position)) return Number.POSITIVE_INFINITY;
  return Math.hypot(Number(position[0]) - target[0], Number(position[2]) - target[2]);
}

/**
 * Own the airport storefront proximity, catalog, focus, listener, and
 * session-local pickup-list lifecycle. Movement, notifications, and world
 * lifecycle remain delegated to their existing owners through injected seams.
 */
export function createAirportStorefrontInteractionController({
  isPlayer,
  documentTarget,
  lookup,
  createElement,
  releaseMovement,
  focusFallback,
  showToast,
  logger,
  isTypingTarget,
}) {
  const body = documentTarget.body;
  const listeners = [];
  const state = {
    mounted: false,
    inAirport: false,
    airportSource: null,
    contract: createAirportStorefrontCatalogContract(null),
    nearest: null,
    nearestDistanceM: null,
    openStoreId: null,
    selectedItemId: null,
    basket: [],
    previousFocus: null,
    lastCloseReason: null,
    lastAction: null,
    status: "Approach an airport storefront to browse.",
    statusTone: "neutral",
  };

  const listen = (target, type, handler) => {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  };
  const currentStore = () => state.contract.stores.find((store) => store.node_id === state.openStoreId) || null;
  const nearestStore = () => state.contract.stores.find((store) => store.node_id === state.nearest) || null;
  const selectedItem = () => currentStore()?.items.find((item) => item.item_id === state.selectedItemId) || null;
  const basketKey = (storeId, itemId) => `${storeId}:${itemId}`;
  const setStatus = (message, tone = "neutral") => {
    state.status = message;
    state.statusTone = tone;
    const status = lookup("storefront-shopping-status");
    if (status) {
      status.textContent = message;
      status.dataset.state = tone;
    }
  };
  const clear = (element) => {
    if (!element) return;
    if (typeof element.replaceChildren === "function") element.replaceChildren();
    else while (element.firstChild) element.removeChild(element.firstChild);
  };
  const appendText = (host, tagName, text, className = "") => {
    const element = createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    host.appendChild(element);
    return element;
  };

  function renderAffordance() {
    const affordance = lookup("storefront-shopping-affordance");
    const store = nearestStore();
    const visible = !!(isPlayer && state.inAirport && store && !state.openStoreId);
    if (affordance) {
      affordance.hidden = !visible;
      affordance.setAttribute("aria-expanded", String(!!state.openStoreId));
      affordance.textContent = store
        ? `Browse ${store.label} · E`
        : "Browse airport storefront · E";
      affordance.setAttribute(
        "aria-label",
        store
          ? `Browse ${store.label}, ${state.nearestDistanceM?.toFixed(1) || "0.0"} metres away. Press E or activate this button.`
          : "Browse the nearest airport storefront",
      );
    }
    if (store) {
      body.setAttribute("data-airport-storefront-nearby", store.category);
      body.setAttribute("data-airport-storefront-distance", state.nearestDistanceM?.toFixed(2) || "0.00");
    } else {
      body.removeAttribute("data-airport-storefront-nearby");
      body.removeAttribute("data-airport-storefront-distance");
    }
  }

  function renderCatalog(store) {
    const host = lookup("storefront-shopping-catalog");
    clear(host);
    if (!host || !store) return;
    if (store.catalog_state !== "ready") {
      const messages = {
        unavailable: store.availability_reason || "This storefront is unavailable in the local demo.",
        empty: "This storefront has an empty local-demo catalog.",
        malformed: `This storefront catalog is malformed and was not loaded. ${store.catalog_errors.join("; ")}`,
      };
      appendText(host, "p", messages[store.catalog_state] || "This storefront catalog cannot be browsed.", "storefront-shopping-message");
      return;
    }
    for (const item of store.items) {
      const button = createElement("button");
      button.type = "button";
      button.className = `storefront-catalog-item${item.item_id === state.selectedItemId ? " active" : ""}`;
      button.id = `storefront-catalog-item-${item.item_id}`;
      button.dataset.itemId = item.item_id;
      button.setAttribute("data-testid", `storefront-catalog-item-${item.item_id}`);
      button.setAttribute("aria-pressed", String(item.item_id === state.selectedItemId));
      appendText(button, "strong", item.name);
      appendText(button, "span", item.summary);
      button.addEventListener("click", () => inspect(item.item_id, { focusDetail: true }));
      host.appendChild(button);
    }
  }

  function renderDetail(store) {
    const host = lookup("storefront-shopping-detail");
    clear(host);
    if (!host || !store) return;
    const item = selectedItem();
    if (store.catalog_state !== "ready" || !item) {
      appendText(host, "p", "Select an available catalog item to inspect it.", "storefront-shopping-message");
      return;
    }
    appendText(host, "h3", item.name);
    appendText(host, "p", item.detail);
    appendText(host, "p", item.pickup_note, "storefront-shopping-pickup-note");
    const key = basketKey(store.node_id, item.item_id);
    const alreadyAdded = state.basket.some((entry) => entry.key === key);
    const add = createElement("button");
    add.type = "button";
    add.id = "btn-storefront-shopping-add";
    add.className = "primary";
    add.dataset.itemId = item.item_id;
    add.setAttribute("data-testid", "storefront-shopping-add");
    add.disabled = alreadyAdded;
    add.textContent = alreadyAdded ? "Already in pickup list" : "Add to local demo pickup list";
    add.addEventListener("click", () => addSelected());
    host.appendChild(add);
  }

  function renderBasket() {
    const host = lookup("storefront-shopping-basket");
    clear(host);
    const count = lookup("storefront-shopping-basket-count");
    if (count) count.textContent = `${state.basket.length} selected`;
    if (!host) return;
    if (!state.basket.length) {
      appendText(host, "p", "Nothing selected. This list is session-local and is not an order.", "storefront-shopping-message");
      return;
    }
    for (const entry of state.basket) {
      const row = createElement("div");
      row.className = "storefront-basket-row";
      row.dataset.basketKey = entry.key;
      const copy = createElement("span");
      appendText(copy, "strong", entry.item_name);
      appendText(copy, "small", entry.store_label);
      row.appendChild(copy);
      const remove = createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.dataset.basketKey = entry.key;
      remove.setAttribute("data-testid", `storefront-shopping-remove-${entry.item_id}`);
      remove.addEventListener("click", () => removeItem(entry.key));
      row.appendChild(remove);
      host.appendChild(row);
    }
  }

  function renderPanel() {
    const panel = lookup("storefront-shopping-panel");
    const store = currentStore();
    if (panel) panel.hidden = !store;
    body.setAttribute("data-airport-shopping-open", String(!!store));
    const title = lookup("storefront-shopping-title");
    const meta = lookup("storefront-shopping-meta");
    if (title) title.textContent = store ? store.label : "Airport storefront";
    if (meta) meta.textContent = store
      ? `${store.category} · ${store.catalog_state} · ${store.pickup_label}`
      : "Local demo pickup list";
    renderCatalog(store);
    renderDetail(store);
    renderBasket();
    setStatus(state.status, state.statusTone);
  }

  function render() {
    renderAffordance();
    renderPanel();
  }

  function restoreFocus(reason) {
    const fallback = typeof focusFallback === "function" ? focusFallback() : null;
    const preferred = reason === "left_range" || reason === "airport_exit" || reason === "dispose"
      ? fallback
      : state.previousFocus;
    for (const target of [preferred, fallback]) {
      if (!target || typeof target.focus !== "function" || target.hidden === true) continue;
      try {
        target.focus();
        return true;
      } catch {}
    }
    return false;
  }

  function close(reason = "exit") {
    const wasOpen = !!state.openStoreId;
    state.openStoreId = null;
    state.selectedItemId = null;
    state.lastCloseReason = reason;
    state.lastAction = `close:${reason}`;
    if (typeof releaseMovement === "function") releaseMovement();
    setStatus(
      reason === "left_range"
        ? "Storefront closed because the player left its interaction range. Movement is available."
        : reason === "airport_exit"
          ? "Airport pickup list cleared on exit. Re-entry starts empty."
          : "Storefront closed. Movement is available.",
      "neutral",
    );
    render();
    if (wasOpen) restoreFocus(reason);
    state.previousFocus = null;
    return debug();
  }

  function openNearest(source = "pointer") {
    const store = nearestStore();
    if (!store || !isPlayer || !state.inAirport) return debug();
    if (!state.openStoreId) {
      const activeElement = documentTarget.activeElement;
      state.previousFocus = activeElement && activeElement !== body
        ? activeElement
        : lookup("storefront-shopping-affordance");
    }
    state.openStoreId = store.node_id;
    state.selectedItemId = store.catalog_state === "ready" && store.items.length ? store.items[0].item_id : null;
    state.lastAction = `open:${source}:${store.node_id}`;
    if (typeof releaseMovement === "function") releaseMovement();
    setStatus(
      store.catalog_state === "ready"
        ? `Browsing ${store.label}. Selections are local-demo pickup entries only.`
        : `Opened ${store.label}: ${store.catalog_state}.`,
      store.catalog_state === "malformed" ? "error" : store.catalog_state === "unavailable" ? "warning" : "neutral",
    );
    render();
    lookup("btn-storefront-shopping-close")?.focus?.();
    if (typeof logger === "function") logger(`airport shopping: opened ${store.label} via ${source}`);
    return debug();
  }

  function inspect(itemId, { focusDetail = false } = {}) {
    const store = currentStore();
    const item = store?.catalog_state === "ready"
      ? store.items.find((entry) => entry.item_id === itemId)
      : null;
    if (!item) {
      setStatus("That catalog item is unavailable.", "warning");
      return debug();
    }
    state.selectedItemId = item.item_id;
    state.lastAction = `inspect:${store.node_id}:${item.item_id}`;
    setStatus(`Inspecting ${item.name}. No inventory or purchase claim is made.`, "neutral");
    renderPanel();
    if (focusDetail) lookup("btn-storefront-shopping-add")?.focus?.();
    return debug();
  }

  function addSelected() {
    const store = currentStore();
    const item = selectedItem();
    if (!store || store.catalog_state !== "ready" || !item) {
      setStatus("No available item can be added.", "warning");
      return { ok: false, reason: "no_available_item", state: debug() };
    }
    const key = basketKey(store.node_id, item.item_id);
    if (state.basket.some((entry) => entry.key === key)) {
      setStatus(`${item.name} is already in the local demo pickup list.`, "neutral");
      return { ok: true, unchanged: true, key, state: debug() };
    }
    state.basket.push({
      key,
      store_id: store.node_id,
      store_label: store.label,
      item_id: item.item_id,
      item_name: item.name,
      pickup_label: store.pickup_label,
    });
    state.lastAction = `add:${key}`;
    setStatus(`${item.name} added once to the local demo pickup list. No order or purchase occurred.`, "success");
    renderPanel();
    if (typeof showToast === "function") {
      showToast("Added to local demo list", `${item.name} · no order or purchase`, "arrived");
    }
    return { ok: true, unchanged: false, key, state: debug() };
  }

  function removeItem(key) {
    const index = state.basket.findIndex((entry) => entry.key === key);
    if (index < 0) return { ok: true, unchanged: true, key, state: debug() };
    const [removed] = state.basket.splice(index, 1);
    state.lastAction = `remove:${key}`;
    setStatus(`${removed.item_name} removed from the local demo pickup list.`, "success");
    renderPanel();
    return { ok: true, unchanged: false, key, state: debug() };
  }

  function stepItem(delta) {
    const store = currentStore();
    if (!store || store.catalog_state !== "ready" || !store.items.length) return debug();
    const index = Math.max(0, store.items.findIndex((item) => item.item_id === state.selectedItemId));
    const next = (index + delta + store.items.length) % store.items.length;
    return inspect(store.items[next].item_id, { focusDetail: false });
  }

  function observe({ locationId, avatarPosition, airportTerminal }) {
    const isAirport = isPlayer && locationId === AIRPORT_LOCATION_ID;
    if (!isAirport) {
      const leavingAirport = state.inAirport;
      state.inAirport = false;
      state.airportSource = null;
      state.contract = createAirportStorefrontCatalogContract(null);
      state.nearest = null;
      state.nearestDistanceM = null;
      if (state.openStoreId) close("airport_exit");
      if (leavingAirport) {
        state.basket = [];
        state.selectedItemId = null;
        state.lastAction = "airport_exit:clear";
        setStatus("Airport pickup list cleared on exit. Re-entry starts empty.", "neutral");
      }
      render();
      return debug();
    }

    state.inAirport = true;
    const contractChanged = state.airportSource !== airportTerminal;
    if (contractChanged) {
      state.airportSource = airportTerminal;
      state.contract = createAirportStorefrontCatalogContract(airportTerminal);
    }
    const nearest = state.contract.stores
      .map((store) => ({ store, distance: planarDistance(avatarPosition, store.position_m) }))
      .filter(({ store, distance }) => store.interaction_radius_m > 0 && distance <= store.interaction_radius_m)
      .sort((left, right) => left.distance - right.distance || left.store.node_id.localeCompare(right.store.node_id))[0] || null;
    state.nearest = nearest ? nearest.store.node_id : null;
    state.nearestDistanceM = nearest ? nearest.distance : null;

    const openStore = currentStore();
    if (openStore && planarDistance(avatarPosition, openStore.position_m) > openStore.interaction_radius_m) {
      close("left_range");
    } else if (contractChanged) {
      render();
    } else {
      renderAffordance();
    }
    return debug();
  }

  function onKeyDown(event) {
    if (state.openStoreId) {
      if (MOVEMENT_CODES.has(event.code)) {
        event.stopPropagation?.();
        if (!(event.code === "Space" && event.target?.tagName?.toLowerCase?.() === "button")) {
          event.preventDefault?.();
        }
        if (typeof releaseMovement === "function") releaseMovement();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault?.();
        event.stopPropagation?.();
        close("escape");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault?.();
        stepItem(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault?.();
        stepItem(1);
      }
      return;
    }
    const typing = typeof isTypingTarget === "function" && isTypingTarget(event.target);
    if ((event.code === "KeyE" || String(event.key).toLowerCase() === "e") && !event.repeat && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault?.();
      openNearest("keyboard");
    }
  }

  function onKeyUp(event) {
    if (!state.openStoreId || !MOVEMENT_CODES.has(event.code)) return;
    event.stopPropagation?.();
    if (!(event.code === "Space" && event.target?.tagName?.toLowerCase?.() === "button")) {
      event.preventDefault?.();
    }
    if (typeof releaseMovement === "function") releaseMovement();
  }

  function debug() {
    return {
      mounted: state.mounted,
      in_airport: state.inAirport,
      contract_ok: state.contract.ok,
      catalog_source: state.contract.source,
      ready_catalog_count: state.contract.ready_count,
      storefronts: state.contract.stores.map((store) => ({
        node_id: store.node_id,
        label: store.label,
        category: store.category,
        catalog_state: store.catalog_state,
        catalog_errors: store.catalog_errors.slice(),
        item_ids: store.items.map((item) => item.item_id),
      })),
      nearest_store_id: state.nearest,
      nearest_distance_m: state.nearestDistanceM === null ? null : Number(state.nearestDistanceM.toFixed(3)),
      open_store_id: state.openStoreId,
      selected_item_id: state.selectedItemId,
      basket: state.basket.map((entry) => ({ ...entry })),
      basket_count: state.basket.length,
      last_close_reason: state.lastCloseReason,
      last_action: state.lastAction,
      status: state.status,
      status_tone: state.statusTone,
      listener_count: listeners.length,
      session_rule: AIRPORT_SHOPPING_SESSION_RULE,
    };
  }

  function mount() {
    if (state.mounted) return controller;
    state.mounted = true;
    listen(lookup("storefront-shopping-affordance"), "click", () => openNearest("pointer"));
    listen(lookup("btn-storefront-shopping-close"), "click", () => close("button"));
    listen(documentTarget, "keydown", onKeyDown);
    listen(documentTarget, "keyup", onKeyUp);
    render();
    return controller;
  }

  function dispose() {
    if (state.openStoreId) close("dispose");
    for (const [target, type, handler] of listeners.splice(0)) target.removeEventListener(type, handler);
    state.mounted = false;
    state.inAirport = false;
    state.airportSource = null;
    state.contract = createAirportStorefrontCatalogContract(null);
    state.nearest = null;
    state.nearestDistanceM = null;
    state.openStoreId = null;
    state.selectedItemId = null;
    state.basket = [];
    state.previousFocus = null;
    body.removeAttribute("data-airport-shopping-open");
    body.removeAttribute("data-airport-storefront-nearby");
    body.removeAttribute("data-airport-storefront-distance");
    const affordance = lookup("storefront-shopping-affordance");
    const panel = lookup("storefront-shopping-panel");
    if (affordance) affordance.hidden = true;
    if (panel) panel.hidden = true;
    return controller;
  }

  const driver = () => Object.freeze({
    open: () => openNearest("driver"),
    close,
    inspect: (itemId) => inspect(itemId),
    add: addSelected,
    remove: removeItem,
    observe,
    state: debug,
  });

  const controller = Object.freeze({
    mount,
    dispose,
    observe,
    openNearest,
    close,
    inspect,
    addSelected,
    removeItem,
    debug,
    driver,
  });
  return controller;
}

export default {
  AIRPORT_SHOPPING_SESSION_RULE,
  createAirportStorefrontCatalogContract,
  createAirportStorefrontInteractionController,
};
