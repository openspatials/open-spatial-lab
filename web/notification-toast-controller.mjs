const NOTIFICATION_RECORD_LIMIT = 50;
const TOAST_DISMISS_MS = 3500;
const TOAST_TRANSITION_MS = 220;

export function createNotificationToastController({
  lookup,
  createElement,
  body,
  eventTarget,
  nowMs,
  nowIso,
  formatTime,
  setTimer,
  clearTimer,
  escapeHtml,
  isTypingTarget,
  motionPreference = null,
  logger = () => {},
}) {
  const requiredFunctions = {
    lookup,
    createElement,
    nowMs,
    nowIso,
    formatTime,
    setTimer,
    clearTimer,
    escapeHtml,
    isTypingTarget,
  };
  for (const [name, value] of Object.entries(requiredFunctions)) {
    if (typeof value !== "function") {
      logger(`notification controller missing ${name}`);
      throw new TypeError(`notification controller requires ${name}`);
    }
  }

  const records = [];
  const mountedListeners = [];
  const rowListeners = [];
  let mounted = false;
  let centerOpen = false;
  let selectedId = null;
  let toastDismissTimer = 0;
  let toastClearTimer = 0;
  let activeToast = null;
  let activeToastClick = null;

  function snapshot() {
    return records.map((record) => JSON.parse(JSON.stringify(record)));
  }

  function kindLabel(record) {
    const kind = record && record.kind ? String(record.kind) : "notification";
    return kind.replace(/_/g, " ");
  }

  function title(record) {
    if (!record) return "Notification";
    return record.title || record.event_type || kindLabel(record);
  }

  function summary(record) {
    if (!record) return "";
    if (record.summary) return record.summary;
    const parts = [];
    if (record.event_type) parts.push(record.event_type);
    if (record.destination && record.destination.location_id) parts.push(`to ${record.destination.location_id}`);
    if (record.source && record.source.location_id) parts.push(`from ${record.source.location_id}`);
    if (record.transfer && Number.isFinite(Number(record.transfer.controls_resume_ms))) {
      parts.push(`through in ${record.transfer.controls_resume_ms} ms`);
    }
    if (record.status) parts.push(record.status);
    return parts.filter(Boolean).join(" · ");
  }

  function time(record) {
    const raw = (record && (record.completed_at || record.updated_at || record.updated || record.created_at || record.created)) || null;
    return raw ? formatTime(raw) : "—";
  }

  function latestByKind(kind) {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index] && records[index].kind === kind) return records[index].id;
    }
    return null;
  }

  function updateChrome() {
    const recordCount = records.length;
    if (body && typeof body.setAttribute === "function") {
      body.setAttribute("data-notification-count", String(recordCount));
    }
    const badge = lookup("notification-count-badge");
    if (badge) badge.textContent = recordCount > 99 ? "99" : String(recordCount);
    const button = lookup("btn-notifications");
    if (button) button.setAttribute("aria-expanded", centerOpen ? "true" : "false");
  }

  function valueRows(record) {
    if (!record) return [];
    const rows = [
      ["kind", kindLabel(record)],
      ["status", record.status || "—"],
      ["time", record.completed_at || record.updated_at || record.created_at || record.created || "—"],
    ];
    if (record.event_type) rows.push(["event", record.event_type]);
    if (record.source) rows.push(["source", [record.source.location_id, record.source.world_id || record.source.endpoint_key].filter(Boolean).join(" · ") || "—"]);
    if (record.destination) rows.push(["destination", [record.destination.location_id, record.destination.world_title || record.destination.world_id].filter(Boolean).join(" · ") || "—"]);
    if (record.crossing && record.crossing.handoff_id) rows.push(["handoff", record.crossing.handoff_id]);
    if (record.transfer && Number.isFinite(Number(record.transfer.controls_resume_ms))) {
      rows.push(["transfer", `${record.transfer.controls_resume_ms} ms`]);
    }
    if (record.prefetch) rows.push(["prefetch", [record.prefetch.status, record.prefetch.address && record.prefetch.address.location_id].filter(Boolean).join(" · ") || "—"]);
    if (record.region && record.region.totals) {
      rows.push(["region", `${record.region.totals.region_entities}/${record.region.totals.fabric_entities} entities`]);
    }
    if (record.occupancy) rows.push(["occupancy", `${(record.occupancy.avatars || []).length} avatars · arrivals ${record.occupancy.arrival_count ?? "—"}`]);
    if (record.honesty) {
      rows.push([
        "claim",
        [
          record.honesty.demonstration_only === true ? "demonstration_only:true" : null,
          record.honesty.standards_conformance === false ? "standards_conformance:false" : null,
        ].filter(Boolean).join(" · ") || "—",
      ]);
    } else if (record.claim_boundary) {
      rows.push(["claim", `standards_conformance:${record.claim_boundary.standards_conformance === true ? "true" : "false"}`]);
    }
    return rows;
  }

  function clearRowListeners() {
    for (const [target, handler] of rowListeners.splice(0)) {
      target.removeEventListener("click", handler);
    }
  }

  function render() {
    updateChrome();
    const center = lookup("notification-center");
    const list = lookup("notification-list");
    const detail = lookup("notification-detail");
    const centerSummary = lookup("notification-summary");
    if (!center || !list || !detail) return;

    center.hidden = !centerOpen;
    if (centerSummary) centerSummary.textContent = `${records.length} ${records.length === 1 ? "record" : "records"}`;
    clearRowListeners();
    list.innerHTML = "";
    detail.innerHTML = "";
    if (!records.length) {
      const empty = createElement("div");
      empty.className = "notification-empty";
      empty.textContent = "No records";
      list.appendChild(empty);
      detail.textContent = "—";
      return;
    }

    if (!selectedId || !records.some((record) => record.id === selectedId)) {
      selectedId = records[records.length - 1].id;
    }
    for (const record of [...records].reverse()) {
      const row = createElement("button");
      row.type = "button";
      row.className = `notification-row${record.id === selectedId ? " active" : ""}`;
      row.dataset.notificationId = record.id;
      row.setAttribute("data-testid", `notification-row-${record.kind || "record"}`);
      const rowTitle = createElement("span");
      rowTitle.className = "kind";
      rowTitle.textContent = title(record);
      const rowTime = createElement("span");
      rowTime.className = "time";
      rowTime.textContent = time(record);
      const rowSummary = createElement("span");
      rowSummary.className = "summary";
      rowSummary.textContent = summary(record);
      row.append(rowTitle, rowTime, rowSummary);
      const selectRecord = () => open(record.id);
      row.addEventListener("click", selectRecord);
      rowListeners.push([row, selectRecord]);
      list.appendChild(row);
    }

    const selected = records.find((record) => record.id === selectedId) || records[records.length - 1];
    const heading = createElement("h4");
    heading.textContent = title(selected);
    detail.appendChild(heading);
    for (const [key, value] of valueRows(selected)) {
      const row = createElement("div");
      row.className = "kv";
      const keyElement = createElement("span");
      keyElement.className = "k";
      keyElement.textContent = key;
      const valueElement = createElement("span");
      valueElement.className = "v";
      valueElement.textContent = value == null || value === "" ? "—" : String(value);
      row.append(keyElement, valueElement);
      detail.appendChild(row);
    }
    if (Array.isArray(selected.steps) && selected.steps.length) {
      const steps = createElement("ul");
      steps.className = "steps";
      for (const step of selected.steps) {
        const item = createElement("li");
        item.className = step.done ? "done" : "";
        item.textContent = `${step.done ? "done" : "wait"} · ${step.label || step.id}${step.done_at ? ` · ${step.done_at}` : ""}`;
        steps.appendChild(item);
      }
      detail.appendChild(steps);
    }
  }

  function publish(record) {
    if (!record || typeof record !== "object") return;
    if (!record.id) record.id = `notification-${nowMs()}-${records.length + 1}`;
    if (!record.created_at && !record.created) record.created_at = nowIso();
    const existing = records.findIndex((item) => item && item.id === record.id);
    if (existing >= 0) records[existing] = record;
    else records.push(record);
    if (records.length > NOTIFICATION_RECORD_LIMIT) {
      records.splice(0, records.length - NOTIFICATION_RECORD_LIMIT);
    }
    if (!selectedId || !records.some((item) => item.id === selectedId)) {
      selectedId = records[records.length - 1]?.id || null;
    }
    updateChrome();
    if (centerOpen) render();
  }

  function open(id) {
    if (id) selectedId = id;
    else if (!selectedId && records.length) selectedId = records[records.length - 1].id;
    centerOpen = true;
    render();
  }

  function close() {
    centerOpen = false;
    render();
  }

  function clearToast({ removeContent = false } = {}) {
    if (toastDismissTimer) clearTimer(toastDismissTimer);
    if (toastClearTimer) clearTimer(toastClearTimer);
    toastDismissTimer = 0;
    toastClearTimer = 0;
    if (activeToast && activeToastClick) activeToast.removeEventListener("click", activeToastClick);
    const stack = lookup("toast-stack");
    if (removeContent && stack && stack.firstElementChild === activeToast) stack.innerHTML = "";
    activeToast = null;
    activeToastClick = null;
  }

  function ensureToastStack() {
    const mount = lookup("scene-mount");
    if (!mount) return null;
    let stack = lookup("toast-stack");
    if (!stack) {
      stack = createElement("div");
      stack.id = "toast-stack";
      stack.className = "toast-stack";
      stack.setAttribute("aria-live", "polite");
      mount.appendChild(stack);
    }
    return stack;
  }

  function show(big, sub, cls, opts = {}) {
    const stack = ensureToastStack();
    if (!stack || !big) return;
    clearToast();
    stack.innerHTML = "";
    const toast = createElement("div");
    toast.className = `toast ${escapeHtml(cls || "")}`;
    const bigText = createElement("div");
    bigText.className = "big";
    bigText.textContent = String(big);
    const subText = createElement("div");
    subText.className = "sub";
    subText.textContent = String(sub || "");
    toast.append(bigText, subText);
    stack.appendChild(toast);
    if (opts.notificationId) {
      toast.dataset.notificationId = opts.notificationId;
      toast.title = "Open notification detail";
      activeToastClick = () => open(opts.notificationId);
      toast.addEventListener("click", activeToastClick);
    }
    activeToast = toast;
    if (motionPreference?.isReduced?.() !== true) void toast.offsetWidth;
    toast.classList.add("toast-visible");
    toastDismissTimer = setTimer(() => {
      toastDismissTimer = 0;
      toast.classList.remove("toast-visible");
      toastClearTimer = setTimer(() => {
        toastClearTimer = 0;
        if (stack.firstElementChild === toast) stack.innerHTML = "";
        if (activeToast === toast) {
          if (activeToastClick) toast.removeEventListener("click", activeToastClick);
          activeToast = null;
          activeToastClick = null;
        }
      }, motionPreference?.isReduced?.() === true ? 0 : TOAST_TRANSITION_MS);
    }, TOAST_DISMISS_MS);
  }

  function addMountedListener(target, type, handler) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, handler);
    mountedListeners.push([target, type, handler]);
  }

  function mount() {
    if (mounted) return api;
    mounted = true;
    addMountedListener(lookup("btn-notifications"), "click", () => (centerOpen ? close() : open()));
    addMountedListener(lookup("btn-notifications-close"), "click", close);
    addMountedListener(eventTarget, "keydown", (event) => {
      if (event.key === "Escape" && centerOpen && !isTypingTarget(event.target)) close();
    });
    render();
    return api;
  }

  function dispose() {
    for (const [target, type, handler] of mountedListeners.splice(0)) {
      target.removeEventListener(type, handler);
    }
    clearRowListeners();
    clearToast({ removeContent: true });
    mounted = false;
  }

  const api = {
    mount,
    dispose,
    publish,
    show,
    open,
    close,
    snapshot,
    count: () => records.length,
    selected: () => selectedId,
    isOpen: () => centerOpen,
    latestByKind,
  };
  return api;
}
