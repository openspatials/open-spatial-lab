import {
  DEMO_TRAJECTORY_SEGMENTS,
  DEMO_TRAJECTORY_SIGNAL,
  createDemoTrajectoryRecorder,
  demoTrajectoryActivation,
} from "./trajectory-recorder.mjs";

const PANEL_ID = "osl-demo-trajectory-panel";
const STYLE_ID = "osl-demo-trajectory-style";
const SHORTCUT_LABEL = "Alt+Shift+T";

function addStyles(document) {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${PANEL_ID} {
  all: initial;
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 2147483000;
  box-sizing: border-box;
  width: min(360px, calc(100vw - 28px));
  padding: 12px;
  border: 1px solid rgba(139, 208, 255, 0.75);
  border-radius: 12px;
  background: rgba(8, 14, 25, 0.96);
  color: #f4f8ff;
  box-shadow: 0 16px 50px rgba(0, 0, 0, 0.48);
  contain: content;
  font: 600 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
}
#${PANEL_ID}[hidden] { display: none !important; }
#${PANEL_ID} * { box-sizing: border-box; }
#${PANEL_ID} .trajectory-title { margin: 0 0 9px; color: #8bd0ff; font-size: 13px; }
#${PANEL_ID} label { display: grid; gap: 4px; color: #b7c8dc; }
#${PANEL_ID} select,
#${PANEL_ID} button {
  min-height: 34px;
  border: 1px solid #42566f;
  border-radius: 7px;
  background: #121f31;
  color: #f4f8ff;
  font: inherit;
}
#${PANEL_ID} select { width: 100%; padding: 5px 8px; }
#${PANEL_ID} button { padding: 6px 10px; cursor: pointer; }
#${PANEL_ID} button:hover { border-color: #8bd0ff; }
#${PANEL_ID} button:disabled { cursor: not-allowed; opacity: 0.42; }
#${PANEL_ID} .trajectory-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 9px 0; }
#${PANEL_ID} .trajectory-status { display: grid; grid-template-columns: auto 1fr; gap: 3px 9px; margin: 0; }
#${PANEL_ID} .trajectory-status dt { color: #8ba0ba; }
#${PANEL_ID} .trajectory-status dd { margin: 0; overflow-wrap: anywhere; }
#${PANEL_ID} .trajectory-hint { margin: 9px 0 0; color: #8ba0ba; font-size: 10px; }
#${PANEL_ID} .trajectory-error { margin: 7px 0 0; color: #ff9f9f; white-space: normal; }
`;
  document.head.append(style);
}

function persistenceUrl(location) {
  const url = new URL("/__demo-authoring/trajectory/accept", location.origin);
  url.searchParams.set("mode", DEMO_TRAJECTORY_SIGNAL);
  return url;
}

async function persistTrace(view, trace) {
  const response = await view.fetch(persistenceUrl(view.location), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-osl-demo-authoring": DEMO_TRAJECTORY_SIGNAL,
    },
    body: JSON.stringify(trace),
  });
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.message || payload.error || `trajectory persistence failed with HTTP ${response.status}`);
  }
  return payload.accepted;
}

function buildPanel(document) {
  const root = document.createElement("section");
  root.id = PANEL_ID;
  root.setAttribute("aria-label", "Demo trajectory recorder");
  root.innerHTML = `
    <h2 class="trajectory-title">Local demo trajectory recorder</h2>
    <label>Segment<select data-control="segment" aria-label="Trajectory segment"></select></label>
    <div class="trajectory-actions">
      <button type="button" data-action="record">Record</button>
      <button type="button" data-action="done">Done</button>
      <button type="button" data-action="redo">Redo</button>
      <button type="button" data-action="hide">Hide controls</button>
    </div>
    <dl class="trajectory-status">
      <dt>Segment</dt><dd data-status="segment">—</dd>
      <dt>State</dt><dd data-status="state">idle</dd>
      <dt>Elapsed</dt><dd data-status="elapsed">0.00 s</dd>
      <dt>Samples</dt><dd data-status="samples">0</dd>
      <dt>Location</dt><dd data-status="location">—</dd>
      <dt>Last event</dt><dd data-status="event">—</dd>
      <dt>Accepted</dt><dd data-status="accepted">0</dd>
    </dl>
    <p class="trajectory-error" data-status="error" hidden></p>
    <p class="trajectory-hint">${SHORTCUT_LABEL} toggles these controls. Recording continues while hidden.</p>
  `;
  const select = root.querySelector('[data-control="segment"]');
  for (const segment of DEMO_TRAJECTORY_SEGMENTS) {
    const option = document.createElement("option");
    option.value = segment.id;
    option.textContent = segment.label;
    select.append(option);
  }
  return root;
}

function rectValue(rect) {
  return {
    x: Number(rect.x.toFixed(3)),
    y: Number(rect.y.toFixed(3)),
    width: Number(rect.width.toFixed(3)),
    height: Number(rect.height.toFixed(3)),
  };
}

export function assertNoTrajectoryGeometryShift(before, after, tolerance = 0.01) {
  const errors = [];
  const compareRect = (left, right, label) => {
    if (!left && !right) return;
    if (!left || !right) {
      errors.push(`${label} presence changed`);
      return;
    }
    for (const key of ["x", "y", "width", "height"]) {
      if (Math.abs(Number(left[key]) - Number(right[key])) > tolerance) errors.push(`${label}.${key} shifted`);
    }
  };
  if (before?.viewport?.width !== after?.viewport?.width || before?.viewport?.height !== after?.viewport?.height) {
    errors.push("viewport dimensions changed");
  }
  if ((before?.canvases?.length || 0) !== (after?.canvases?.length || 0)) errors.push("canvas count changed");
  const count = Math.min(before?.canvases?.length || 0, after?.canvases?.length || 0);
  for (let index = 0; index < count; index += 1) compareRect(before.canvases[index], after.canvases[index], `canvas ${index}`);
  compareRect(before?.app, after?.app, "app");
  if (errors.length) throw new Error(`trajectory panel geometry leak: ${errors.join("; ")}`);
  return true;
}

export function mountDemoTrajectoryTool({ view = window, document = view.document, role, snapshot } = {}) {
  if (!demoTrajectoryActivation({ location: view.location, role })) return null;
  if (document.getElementById(PANEL_ID)) throw new Error("demo trajectory recorder is already mounted");

  addStyles(document);
  const root = buildPanel(document);
  document.body.append(root);
  const recorder = createDemoTrajectoryRecorder({
    snapshot,
    persist: (trace) => persistTrace(view, trace),
  });
  const select = root.querySelector('[data-control="segment"]');
  const recordButton = root.querySelector('[data-action="record"]');
  const doneButton = root.querySelector('[data-action="done"]');
  const redoButton = root.querySelector('[data-action="redo"]');
  const hideButton = root.querySelector('[data-action="hide"]');
  let visible = true;
  let disposed = false;

  function setText(name, value) {
    root.querySelector(`[data-status="${name}"]`).textContent = String(value);
  }

  function render(state) {
    root.dataset.recorderState = state.status;
    setText("segment", state.selected_segment_label || "—");
    setText("state", state.status);
    setText("elapsed", `${(state.elapsed_ms / 1000).toFixed(2)} s`);
    setText("samples", state.sample_count);
    setText("location", state.current_location || state.last_accepted?.trace?.samples?.at(-1)?.location?.location_id || "—");
    setText("event", state.last_semantic_event ? `${state.last_semantic_event.name}: ${state.last_semantic_event.value}` : "—");
    setText("accepted", state.accepted_take_count);
    select.value = state.selected_segment_id;
    select.disabled = state.status === "recording";
    recordButton.disabled = state.status === "recording";
    doneButton.disabled = state.status !== "recording";
    redoButton.disabled = state.status === "idle" && !state.candidate && state.accepted_take_count === 0;
    const error = root.querySelector('[data-status="error"]');
    error.hidden = !state.error;
    error.textContent = state.error || "";
  }

  function show(reason = "manual") {
    visible = true;
    root.hidden = false;
    root.style.display = "block";
    root.dataset.visibilityReason = reason;
    return recorder.snapshot();
  }

  function hide(reason = "manual") {
    visible = false;
    root.hidden = true;
    root.style.display = "none";
    root.dataset.visibilityReason = reason;
    return recorder.snapshot();
  }

  function toggle(reason = "shortcut") {
    return visible ? hide(reason) : show(reason);
  }

  function reportActionError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const target = root.querySelector('[data-status="error"]');
    target.hidden = false;
    target.textContent = message;
  }

  select.addEventListener("change", () => {
    try { recorder.setSelectedSegment(select.value); } catch (error) { reportActionError(error); }
  });
  recordButton.addEventListener("click", () => {
    try {
      recorder.start();
      hide("recording-started");
    } catch (error) {
      reportActionError(error);
    }
  });
  doneButton.addEventListener("click", async () => {
    doneButton.disabled = true;
    try { await recorder.done(); } catch (error) { reportActionError(error); }
  });
  redoButton.addEventListener("click", () => {
    try {
      recorder.redo();
      hide("redo-started");
    } catch (error) {
      reportActionError(error);
    }
  });
  hideButton.addEventListener("click", () => hide("hide-button"));

  const onShortcut = (event) => {
    const isToggleKey = event.code === "KeyT" || String(event.key).toLowerCase() === "t";
    if (event.altKey && event.shiftKey && isToggleKey) {
      event.preventDefault();
      event.stopPropagation();
      toggle("shortcut");
    }
  };
  const onReplayStart = () => hide("future-replay-start");
  document.addEventListener("keydown", onShortcut, true);
  view.addEventListener("demo-trajectory-replay-starting", onReplayStart);
  const unsubscribe = recorder.subscribe(render);

  return Object.freeze({
    show,
    hide,
    toggle,
    isVisible: () => visible,
    shortcut: SHORTCUT_LABEL,
    snapshot: () => ({ ...recorder.snapshot(), panel_visible: visible }),
    geometrySnapshot: () => ({
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      canvases: Array.from(document.querySelectorAll("canvas")).map((canvas) => rectValue(canvas.getBoundingClientRect())),
      app: document.getElementById("app") ? rectValue(document.getElementById("app").getBoundingClientRect()) : null,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      recorder.dispose();
      document.removeEventListener("keydown", onShortcut, true);
      view.removeEventListener("demo-trajectory-replay-starting", onReplayStart);
      root.remove();
      document.getElementById(STYLE_ID)?.remove();
    },
  });
}
