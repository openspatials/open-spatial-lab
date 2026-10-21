const PALETTE_DEFAULT_WIDTH_PX = 430;
const PALETTE_DEFAULT_HEIGHT_PX = 390;
const PALETTE_MIN_WIDTH_PX = 360;
const PALETTE_MIN_HEIGHT_PX = 280;
const PALETTE_MAX_WIDTH_PX = 720;
const PALETTE_MAX_HEIGHT_PX = 720;
const PALETTE_EDGE_PX = 8;
const PALETTE_TOP_PX = 80;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
  return number;
}

function closeEnough(a, b, tolerance = 1e-12) {
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

function normalizedEntryValue(entry, value) {
  const numeric = finiteNumber(value, entry.key);
  const clamped = Math.min(entry.max, Math.max(entry.min, numeric));
  if (closeEnough(clamped, entry.sourceDerivedDefault)) return entry.sourceDerivedDefault;
  const steps = Math.round((clamped - entry.min) / entry.step);
  return Math.min(entry.max, Math.max(entry.min, Number((entry.min + steps * entry.step).toFixed(12))));
}

export function clampPaletteSize({
  width,
  height,
  viewportWidth,
  viewportHeight,
  top = PALETTE_TOP_PX,
  edge = PALETTE_EDGE_PX,
} = {}) {
  const availableWidth = Math.max(1, finiteNumber(viewportWidth, "viewportWidth") - edge * 2);
  const availableHeight = Math.max(1, finiteNumber(viewportHeight, "viewportHeight") - top - edge);
  const maxWidth = Math.min(PALETTE_MAX_WIDTH_PX, availableWidth);
  const maxHeight = Math.min(PALETTE_MAX_HEIGHT_PX, availableHeight);
  const minWidth = Math.min(PALETTE_MIN_WIDTH_PX, maxWidth);
  const minHeight = Math.min(PALETTE_MIN_HEIGHT_PX, maxHeight);
  return {
    width: Math.min(maxWidth, Math.max(minWidth, finiteNumber(width, "width"))),
    height: Math.min(maxHeight, Math.max(minHeight, finiteNumber(height, "height"))),
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
  };
}

export function validateTweakRegistry(registry) {
  if (!Array.isArray(registry) || registry.length === 0) throw new TypeError("tweak registry must be a non-empty array");
  const keys = new Set();
  for (const entry of registry) {
    for (const field of ["key", "label", "units", "description", "rangeRationale"]) {
      if (!entry || typeof entry[field] !== "string" || !entry[field]) {
        throw new TypeError(`registry entry ${entry?.key || "unknown"} is missing ${field}`);
      }
    }
    for (const field of ["sourceDerivedDefault", "currentValue", "precision", "min", "max", "step"]) {
      finiteNumber(entry[field], `${entry.key}.${field}`);
    }
    if (keys.has(entry.key)) throw new TypeError(`duplicate tweak key ${entry.key}`);
    if (!/^[a-z][a-z0-9_]*$/.test(entry.key)) throw new TypeError(`tweak key must be snake_case: ${entry.key}`);
    if (entry.min >= entry.max || entry.step <= 0) throw new RangeError(`invalid range for ${entry.key}`);
    if (entry.sourceDerivedDefault < entry.min || entry.sourceDerivedDefault > entry.max) {
      throw new RangeError(`${entry.key} source default is outside the measured range`);
    }
    if (typeof entry.read !== "function" || typeof entry.apply !== "function") {
      throw new TypeError(`${entry.key} requires runtime read/apply hooks`);
    }
    keys.add(entry.key);
  }
  return registry;
}

export function formatTweakLine(entry) {
  const value = finiteNumber(entry.read(), `${entry.key}.read()`);
  entry.currentValue = value;
  return `${entry.key}: ${value.toFixed(entry.precision)}`;
}

export function copyAllTweakText(registry) {
  return validateTweakRegistry(registry).map(formatTweakLine).join("\n");
}

export function createRunTweakRegistry({ sourceDefaults, readCalibration, applyCalibration } = {}) {
  if (typeof readCalibration !== "function" || typeof applyCalibration !== "function") {
    throw new TypeError("run tweak registry requires readCalibration and applyCalibration hooks");
  }
  const speedDefault = finiteNumber(sourceDefaults?.run_cycle_speed, "run_cycle_speed default");
  const distanceDefault = finiteNumber(sourceDefaults?.run_cycle_distance, "run_cycle_distance default");
  const specifications = [
    {
      key: "run_cycle_speed",
      label: "Run cycle speed",
      units: "cycles/s",
      sourceDerivedDefault: speedDefault,
      precision: 4,
      min: 2.7 / distanceDefault,
      max: 3.15 / distanceDefault,
      step: 0.001,
      description: "Completed run-animation cycles per second.",
      rangeRationale: "2.7-3.0 m/s is the preferred measured jog envelope; 3.15 m/s (195.092 steps/min) is the hard clip limit.",
    },
  ];
  let registry;
  registry = specifications.map((specification) => {
    const entry = {
      ...specification,
      currentValue: specification.sourceDerivedDefault,
      read() {
        const calibration = readCalibration();
        entry.currentValue = finiteNumber(calibration?.[entry.key], `${entry.key} runtime value`);
        return entry.currentValue;
      },
      apply(value) {
        const requested = { ...readCalibration() };
        if (!closeEnough(requested.run_cycle_distance, distanceDefault, 1e-9)) {
          throw new RangeError("run_cycle_distance drifted from the measured clip authority");
        }
        requested[entry.key] = normalizedEntryValue(entry, value);
        const applied = applyCalibration(requested) || readCalibration();
        for (const item of registry) {
          item.currentValue = finiteNumber(applied?.[item.key], `${item.key} applied value`);
        }
        return entry.currentValue;
      },
    };
    return entry;
  });
  return validateTweakRegistry(registry);
}

export function createRuntimeTweakController({
  view,
  document,
  toggle,
  palette,
  rows,
  closeButton,
  copyAllButton,
  resetAllButton,
  status,
  fallback,
  resizeHandle,
  registry,
} = {}) {
  validateTweakRegistry(registry);
  if (!view || !document || !toggle || !palette || !rows || !closeButton || !copyAllButton ||
      !resetAllButton || !status || !fallback || !resizeHandle) {
    throw new TypeError("runtime tweak controller is missing required DOM owners");
  }

  const rowRefs = new Map();
  const removers = [];
  let mounted = false;
  let returnFocus = null;
  let drag = null;
  let clipboardWriter = null;

  const listen = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    removers.push(() => target.removeEventListener(type, listener, options));
  };

  const nativeClipboardWrite = (text) => {
    const clipboard = view.navigator && view.navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      return Promise.reject(new Error("Clipboard API unavailable"));
    }
    return clipboard.writeText(text);
  };

  const sizeSnapshot = () => {
    const rect = palette.getBoundingClientRect();
    return clampPaletteSize({
      width: rect.width || PALETTE_DEFAULT_WIDTH_PX,
      height: rect.height || PALETTE_DEFAULT_HEIGHT_PX,
      viewportWidth: view.innerWidth,
      viewportHeight: view.innerHeight,
    });
  };

  const resizeTo = (width, height) => {
    const next = clampPaletteSize({
      width,
      height,
      viewportWidth: view.innerWidth,
      viewportHeight: view.innerHeight,
    });
    palette.style.width = `${next.width}px`;
    palette.style.height = `${next.height}px`;
    palette.dataset.width = String(next.width);
    palette.dataset.height = String(next.height);
    return next;
  };

  const syncRows = () => {
    for (const entry of registry) {
      const refs = rowRefs.get(entry.key);
      if (!refs) continue;
      const value = entry.read();
      refs.range.value = String(value);
      refs.number.value = value.toFixed(entry.precision);
      refs.line.textContent = formatTweakLine(entry);
    }
  };

  const announce = (message, stateName = "neutral") => {
    status.textContent = message;
    status.dataset.state = stateName;
  };

  const clearCopyFallback = () => {
    fallback.hidden = true;
    fallback.value = "";
  };

  const showCopyFailure = (text, error) => {
    fallback.hidden = false;
    fallback.value = text;
    fallback.setAttribute("aria-label", "Clipboard copy failed; select and copy this text manually");
    fallback.focus();
    fallback.select();
    announce(`Copy failed: ${error?.message || "clipboard rejected the request"}. Select the text below.`, "error");
    return { ok: false, text, error: error?.message || String(error) };
  };

  const copyText = async (text, label) => {
    try {
      await (clipboardWriter || nativeClipboardWrite)(text);
      clearCopyFallback();
      announce(`Copied ${label}.`, "success");
      return { ok: true, text };
    } catch (error) {
      return showCopyFailure(text, error);
    }
  };

  const copyRow = (key) => {
    const entry = registry.find((candidate) => candidate.key === key);
    if (!entry) throw new RangeError(`unknown tweak ${key}`);
    return copyText(formatTweakLine(entry), key);
  };

  const copyAll = () => copyText(copyAllTweakText(registry), "all runtime tweaks");

  const setValue = (key, value, message = true) => {
    const entry = registry.find((candidate) => candidate.key === key);
    if (!entry) throw new RangeError(`unknown tweak ${key}`);
    entry.apply(value);
    syncRows();
    clearCopyFallback();
    if (message) announce(`Applied ${formatTweakLine(entry)}.`, "applied");
    return entry.currentValue;
  };

  const resetValue = (key) => {
    const entry = registry.find((candidate) => candidate.key === key);
    if (!entry) throw new RangeError(`unknown tweak ${key}`);
    setValue(key, entry.sourceDerivedDefault, false);
    announce(`Reset ${key} to ${entry.sourceDerivedDefault.toFixed(entry.precision)}.`, "reset");
    return entry.currentValue;
  };

  const resetAll = () => {
    for (const entry of registry) setValue(entry.key, entry.sourceDerivedDefault, false);
    announce("Reset all runtime tweaks to source-derived defaults.", "reset");
    return snapshot();
  };

  const open = () => {
    if (!palette.hidden) return;
    returnFocus = document.activeElement;
    palette.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    resizeTo(sizeSnapshot().width, sizeSnapshot().height);
    syncRows();
    view.requestAnimationFrame(() => rowRefs.get(registry[0].key)?.range.focus());
  };

  const close = ({ restoreFocus = true } = {}) => {
    if (palette.hidden) return;
    palette.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (restoreFocus && returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
    returnFocus = null;
  };

  const renderRows = () => {
    const rendered = registry.map((entry) => {
      const row = document.createElement("section");
      row.className = "runtime-tweak-row";
      row.dataset.tweakKey = entry.key;
      row.dataset.testid = `runtime-tweak-row-${entry.key}`;

      const heading = document.createElement("div");
      heading.className = "runtime-tweak-row-head";
      const label = document.createElement("label");
      label.htmlFor = `runtime-tweak-range-${entry.key}`;
      label.textContent = entry.label;
      const marker = document.createElement("span");
      marker.className = "runtime-tweak-default";
      marker.dataset.testid = `runtime-tweak-default-${entry.key}`;
      marker.textContent = `default ${entry.sourceDerivedDefault.toFixed(entry.precision)} ${entry.units}`;
      heading.append(label, marker);

      const description = document.createElement("p");
      description.className = "runtime-tweak-description";
      description.textContent = entry.description;

      const controls = document.createElement("div");
      controls.className = "runtime-tweak-inputs";
      const range = document.createElement("input");
      range.id = `runtime-tweak-range-${entry.key}`;
      range.dataset.testid = `runtime-tweak-range-${entry.key}`;
      range.type = "range";
      range.min = String(entry.min);
      range.max = String(entry.max);
      range.step = String(entry.step);
      range.value = String(entry.currentValue);
      const number = document.createElement("input");
      number.className = "runtime-tweak-number";
      number.dataset.testid = `runtime-tweak-number-${entry.key}`;
      number.type = "number";
      number.min = String(entry.min);
      number.max = String(entry.max);
      number.step = String(entry.step);
      number.value = entry.currentValue.toFixed(entry.precision);
      number.setAttribute("aria-label", `${entry.label} numeric value`);
      const units = document.createElement("span");
      units.className = "runtime-tweak-units";
      units.textContent = entry.units;
      controls.append(range, number, units);

      const output = document.createElement("div");
      output.className = "runtime-tweak-output";
      const line = document.createElement("code");
      line.dataset.testid = `runtime-tweak-line-${entry.key}`;
      line.textContent = formatTweakLine(entry);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.dataset.testid = `runtime-tweak-copy-${entry.key}`;
      copy.textContent = "Copy";
      copy.setAttribute("aria-label", `Copy ${entry.key}`);
      const reset = document.createElement("button");
      reset.type = "button";
      reset.dataset.testid = `runtime-tweak-reset-${entry.key}`;
      reset.textContent = "Reset";
      reset.setAttribute("aria-label", `Reset ${entry.key} to its source-derived default`);
      output.append(line, copy, reset);
      row.append(heading, description, controls, output);

      const applyInput = (event) => {
        if (event.target.value === "" || !Number.isFinite(Number(event.target.value))) return;
        try {
          setValue(entry.key, event.target.value);
        } catch (error) {
          announce(`Could not apply ${entry.key}: ${error.message}`, "error");
        }
      };
      listen(range, "input", applyInput);
      listen(number, "change", applyInput);
      listen(copy, "click", () => void copyRow(entry.key));
      listen(reset, "click", () => resetValue(entry.key));
      rowRefs.set(entry.key, { row, range, number, line, copy, reset });
      return row;
    });
    rows.replaceChildren(...rendered);
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    const size = sizeSnapshot();
    drag = { x: event.clientX, y: event.clientY, width: size.width, height: size.height };
    resizeHandle.dataset.dragging = "1";
    resizeHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (!drag) return;
    resizeTo(drag.width + event.clientX - drag.x, drag.height + event.clientY - drag.y);
    event.preventDefault();
  };

  const onPointerUp = (event) => {
    if (!drag) return;
    drag = null;
    delete resizeHandle.dataset.dragging;
    resizeHandle.releasePointerCapture?.(event.pointerId);
  };

  const onResizeKey = (event) => {
    const size = sizeSnapshot();
    const delta = event.shiftKey ? 40 : 10;
    if (event.key === "Home") resizeTo(PALETTE_DEFAULT_WIDTH_PX, PALETTE_DEFAULT_HEIGHT_PX);
    else if (event.key === "ArrowLeft") resizeTo(size.width - delta, size.height);
    else if (event.key === "ArrowRight") resizeTo(size.width + delta, size.height);
    else if (event.key === "ArrowUp") resizeTo(size.width, size.height - delta);
    else if (event.key === "ArrowDown") resizeTo(size.width, size.height + delta);
    else return;
    event.preventDefault();
  };

  const snapshot = () => ({
    open: !palette.hidden,
    registry: registry.map((entry) => ({
      key: entry.key,
      label: entry.label,
      units: entry.units,
      source_derived_default: entry.sourceDerivedDefault,
      current_value: entry.read(),
      precision: entry.precision,
      min: entry.min,
      max: entry.max,
      step: entry.step,
      description: entry.description,
      range_rationale: entry.rangeRationale,
      copy_line: formatTweakLine(entry),
    })),
    copy_all: copyAllTweakText(registry),
    copy_status: status.textContent,
    copy_state: status.dataset.state || "neutral",
    fallback_visible: !fallback.hidden,
    fallback_text: fallback.value,
    size: sizeSnapshot(),
  });

  const mount = () => {
    if (mounted) return;
    mounted = true;
    renderRows();
    resizeTo(PALETTE_DEFAULT_WIDTH_PX, PALETTE_DEFAULT_HEIGHT_PX);
    toggle.hidden = false;
    listen(toggle, "click", () => palette.hidden ? open() : close());
    listen(closeButton, "click", () => close());
    listen(copyAllButton, "click", () => void copyAll());
    listen(resetAllButton, "click", resetAll);
    listen(resizeHandle, "pointerdown", onPointerDown);
    listen(view, "pointermove", onPointerMove);
    listen(view, "pointerup", onPointerUp);
    listen(resizeHandle, "keydown", onResizeKey);
    listen(view, "resize", () => resizeTo(sizeSnapshot().width, sizeSnapshot().height));
    listen(document, "keydown", (event) => {
      if (event.key === "Escape" && !palette.hidden) {
        event.preventDefault();
        close();
      }
    });
    syncRows();
  };

  const dispose = () => {
    close({ restoreFocus: false });
    while (removers.length) removers.pop()();
    rowRefs.clear();
    rows.replaceChildren();
    toggle.hidden = true;
    mounted = false;
  };

  return {
    mount,
    dispose,
    open,
    close,
    setValue,
    resetValue,
    resetAll,
    copyRow,
    copyAll,
    resizeTo,
    snapshot,
    registry: () => registry,
    setClipboardWriterForTest(writer = null) {
      clipboardWriter = typeof writer === "function" ? writer : null;
    },
  };
}
