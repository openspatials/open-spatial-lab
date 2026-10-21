const REDACTED = "[redacted]";
const REDACTED_ORIGIN = "[origin redacted]";
const REDACTED_PATH = "[local path redacted]";

const SECRET_KEY_PATTERN = /(?:^|[_-])(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key|key[_-]?material|spki|jwk|certificate)(?:$|[_-])/i;
const PRIVATE_ID_KEY_PATTERN = /^(?:player|client|avatar|continuity|session|handoff|context|correlation|connection)(?:[_-]?id)?$/i;
const PERSONAL_KEY_PATTERN = /^(?:display[_-]?name|email|age|account[_-]?name|first[_-]?name|last[_-]?name)$/i;
const DID_KEY_PATTERN = /^(?:did|did[_-]?subject|did[_-]?key|key[_-]?id|kid)$/i;
const TIMESTAMP_KEY_PATTERN = /(?:^|[_-])(?:at|date|time|timestamp|ts)(?:$|[_-])/i;
const INTERNAL_PORT_KEY_PATTERN = /(?:^|[_-])(?:port|http[_-]?port|https[_-]?port|ws[_-]?port)(?:$|[_-])/i;
const SIGNATURE_SAFE_KEYS = new Set([
  "algorithm",
  "canonicalization",
  "profile",
  "signature_profile",
  "verified",
  "signature_verified",
  "chain_verified",
  "validity_ok",
]);

function pointerFor(tokens) {
  if (!tokens.length) return "";
  return `/${tokens.map((token) => String(token).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function redactString(value) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    return { value: REDACTED, changed: true };
  }
  if (/^did:/i.test(value) || /^urn:uuid:/i.test(value)) {
    return { value: REDACTED, changed: true };
  }
  let output = value;
  let changed = false;
  const replace = (pattern, replacement) => {
    const next = output.replace(pattern, replacement);
    if (next !== output) changed = true;
    output = next;
  };
  replace(/(?:^|\s)(?:\/Users|\/home|\/private\/var|\/var\/folders)\/[^\s"']+/g, (match) => {
    const leading = /^\s/.test(match) ? match[0] : "";
    return `${leading}${REDACTED_PATH}`;
  });
  replace(/\b(?:https?|wss?):\/\/(?:\[[^\]]+\]|[^/\s"']+)(?=\/|\b)/gi, REDACTED_ORIGIN);
  replace(/\b(?:localhost|127(?:\.\d{1,3}){3}):\d{2,5}\b/gi, `${REDACTED_ORIGIN}`);
  replace(/(\/sessions\/)[^/\s"']+/gi, `$1${REDACTED}`);
  replace(/(\/wow\/user\/)[^/\s"']+/gi, `$1${REDACTED}`);
  replace(/:\d{2,5}(?=\/|\b)/g, ":[port redacted]");
  replace(/\b(?:player-\d{6,}[A-Za-z0-9_-]*|(?:avatar|continuity|session|handoff|context|connection)-(?:local|private)-[A-Za-z0-9_-]+)\b/gi, REDACTED);
  replace(/\bomb-ctx-[A-Za-z0-9_-]+\b/gi, REDACTED);
  replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, REDACTED);
  if (/^(?:[A-Fa-f0-9]{96,}|[A-Za-z0-9+/_-]{120,}={0,2})$/.test(output)) {
    output = REDACTED;
    changed = true;
  }
  return { value: output, changed };
}

function shouldRedactKey(key, value, context) {
  if (key.startsWith("__") && key !== "__wo116_signature_verified") return true;
  if (SECRET_KEY_PATTERN.test(key) || PRIVATE_ID_KEY_PATTERN.test(key) || PERSONAL_KEY_PATTERN.test(key)) return true;
  if (DID_KEY_PATTERN.test(key) || TIMESTAMP_KEY_PATTERN.test(key)) return true;
  if (INTERNAL_PORT_KEY_PATTERN.test(key)) return true;
  if (context.sourceKind === "user" && context.depth === 0 && key === "id") return true;
  if (key === "id" && context.pathTokens.some((token) => /^(?:users?|avatars?|sessions?|presence)$/i.test(String(token)))) return true;
  if (key === "subject" && typeof value === "string" && /^did:/i.test(value)) return true;
  if (/signature(?:[_-]?(?:bytes|value))?$/i.test(key) && (value == null || typeof value !== "object")) return true;
  if (context.inSignature && value != null && typeof value !== "object" && !SIGNATURE_SAFE_KEYS.has(key)) return true;
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Return a detached, frozen presentation value plus every JSON Pointer changed
 * by the deterministic privacy transform. The input is never mutated.
 */
export function redactPresentationValue(input, options = {}) {
  const redactedPaths = [];
  const seen = new WeakSet();
  const sourceKind = String(options.sourceKind || "").toLowerCase();

  const visit = (value, tokens, context) => {
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return String(value);
    if (typeof value === "string") {
      const result = redactString(value);
      if (result.changed) redactedPaths.push(pointerFor(tokens));
      return result.value;
    }
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) {
      redactedPaths.push(pointerFor(tokens));
      return "[redacted circular reference]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((child, index) => visit(child, [...tokens, index], {
        ...context,
        depth: context.depth + 1,
      }));
    }
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const childTokens = [...tokens, key];
      if (shouldRedactKey(key, child, { ...context, pathTokens: tokens })) {
        output[key] = REDACTED;
        redactedPaths.push(pointerFor(childTokens));
        continue;
      }
      output[key] = visit(child, childTokens, {
        sourceKind,
        depth: context.depth + 1,
        inSignature: context.inSignature || /^signature$/i.test(key),
        pathTokens: childTokens,
      });
    }
    return output;
  };

  const value = visit(input === undefined ? null : input, [], {
    sourceKind,
    depth: 0,
    inSignature: false,
    pathTokens: [],
  });
  const uniquePaths = [...new Set(redactedPaths)].sort();
  return deepFreeze({
    value: deepFreeze(value),
    redacted: uniquePaths.length > 0,
    redactedPaths: deepFreeze(uniquePaths),
  });
}

/** Normalize either RFC 6901 JSON Pointer or a simple dot/bracket path. */
export function normalizePresentationPath(input) {
  const raw = String(input == null ? "" : input).trim();
  if (raw === "" || raw === "$") return { ok: true, pointer: "" };
  if (raw.startsWith("/")) {
    const encodedTokens = raw.slice(1).split("/");
    const tokens = [];
    for (const token of encodedTokens) {
      if (/~(?:[^01]|$)/.test(token)) return { ok: false, error: "Invalid JSON Pointer escape." };
      tokens.push(token.replace(/~1/g, "/").replace(/~0/g, "~"));
    }
    return { ok: true, pointer: pointerFor(tokens) };
  }

  const source = raw.replace(/^\$\.?/, "");
  const tokens = [];
  let token = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === ".") {
      if (!token && source[index - 1] === "]") continue;
      if (!token) return { ok: false, error: "Dot paths cannot contain empty segments." };
      tokens.push(token);
      token = "";
      continue;
    }
    if (character === "[") {
      if (token) {
        tokens.push(token);
        token = "";
      }
      const end = source.indexOf("]", index + 1);
      if (end === -1) return { ok: false, error: "Array path is missing a closing bracket." };
      const arrayToken = source.slice(index + 1, end);
      if (!/^\d+$/.test(arrayToken)) return { ok: false, error: "Array path indexes must be non-negative integers." };
      tokens.push(arrayToken);
      index = end;
      if (source[index + 1] && source[index + 1] !== "." && source[index + 1] !== "[") {
        return { ok: false, error: "Unexpected text after an array index." };
      }
      continue;
    }
    token += character;
  }
  if (token) tokens.push(token);
  if (!tokens.length) return { ok: false, error: "Enter a JSON Pointer or dot path." };
  return { ok: true, pointer: pointerFor(tokens) };
}

function primitiveTokens(value) {
  if (value === null) return [{ kind: "null", text: "null" }];
  if (typeof value === "string") return [{ kind: "string", text: JSON.stringify(value) }];
  if (typeof value === "boolean") return [{ kind: "boolean", text: String(value) }];
  return [{ kind: "number", text: String(value) }];
}

/** Build deterministic, two-space JSON lines without interpolating data as HTML. */
export function buildPresentationJsonLines(value) {
  const lines = [];
  const visit = (current, pointer, depth, prefix, trailing) => {
    const suffix = trailing ? "," : "";
    if (current == null || typeof current !== "object") {
      lines.push({ pointer, depth, tokens: [...prefix, ...primitiveTokens(current), { kind: "punctuation", text: suffix }] });
      return;
    }
    const isArray = Array.isArray(current);
    const entries = isArray ? current.map((child, index) => [String(index), child]) : Object.entries(current);
    lines.push({
      pointer,
      depth,
      tokens: [...prefix, { kind: "punctuation", text: isArray ? "[" : "{" }],
    });
    entries.forEach(([key, child], index) => {
      const childPointer = pointerFor([...(pointer === "" ? [] : pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))), key]);
      const childPrefix = isArray
        ? []
        : [{ kind: "key", text: JSON.stringify(key) }, { kind: "punctuation", text: ": " }];
      visit(child, childPointer, depth + 1, childPrefix, index < entries.length - 1);
    });
    lines.push({
      pointer: `${pointer}#close`,
      depth,
      tokens: [{ kind: "punctuation", text: `${isArray ? "]" : "}"}${suffix}` }],
    });
  };
  visit(value === undefined ? null : value, "", 0, [], false);
  return deepFreeze(lines);
}

function presentationSource(source) {
  const safe = redactPresentationValue(source || {}).value;
  return deepFreeze({
    id: String(safe.id || "presentation-json"),
    label: String(safe.label || "JSON preview"),
    method: safe.method ? String(safe.method) : "",
    path: safe.path ? String(safe.path) : "",
    schema: safe.schema ? String(safe.schema) : "",
    status: safe.status == null ? "" : String(safe.status),
    freshness: String(safe.freshness || "Current panel snapshot"),
    state: String(safe.state || "current"),
    sourceKind: String(source && source.sourceKind || ""),
  });
}

function previewText(snapshot) {
  const context = [snapshot.source.method, snapshot.source.path, snapshot.source.status, snapshot.source.schema]
    .filter(Boolean)
    .join(" · ");
  const redaction = snapshot.redacted
    ? `redacted · ${snapshot.redactedPaths.length} protected field${snapshot.redactedPaths.length === 1 ? "" : "s"}`
    : "redacted · no protected fields present";
  return [
    `// ${snapshot.source.label}`,
    context ? `// ${context}` : "",
    `// ${snapshot.source.freshness}`,
    `// ${redaction}`,
    JSON.stringify(snapshot.value, null, 2),
  ].filter(Boolean).join("\n");
}

export function createPresentationJsonViewer(options = {}) {
  const {
    lookup,
    documentTarget,
    windowTarget,
    body,
  } = options;
  if (typeof lookup !== "function" || !documentTarget || !windowTarget || !body) {
    throw new Error("presentation JSON viewer requires explicit DOM roots");
  }

  const snapshots = new Map();
  const listeners = [];
  let activeSnapshot = null;
  let activeTrigger = null;
  let mounted = false;

  const on = (target, type, listener, settings) => {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, listener, settings);
    listeners.push(() => target.removeEventListener(type, listener, settings));
  };

  const renderModalValue = (value) => {
    const output = lookup("presentation-json-output");
    if (!output) return;
    output.replaceChildren();
    for (const line of buildPresentationJsonLines(value)) {
      const row = documentTarget.createElement("div");
      row.className = "presentation-json-line";
      row.setAttribute("data-json-pointer", line.pointer);
      row.append(documentTarget.createTextNode("  ".repeat(line.depth)));
      for (const token of line.tokens) {
        const span = documentTarget.createElement("span");
        span.className = `presentation-json-${token.kind}`;
        span.textContent = token.text;
        row.append(span);
      }
      output.append(row);
    }
  };

  const clearHighlight = () => {
    const output = lookup("presentation-json-output");
    if (!output) return;
    output.querySelectorAll(".presentation-json-highlight").forEach((row) => {
      row.classList.remove("presentation-json-highlight");
    });
  };

  const highlight = (path) => {
    const status = lookup("presentation-json-path-status");
    const normalized = normalizePresentationPath(path);
    clearHighlight();
    if (!normalized.ok) {
      if (status) status.textContent = normalized.error;
      return { ok: false, error: normalized.error };
    }
    const output = lookup("presentation-json-output");
    const row = output
      ? Array.from(output.querySelectorAll("[data-json-pointer]")).find((candidate) =>
          candidate.getAttribute("data-json-pointer") === normalized.pointer
        )
      : null;
    if (!row) {
      const message = `Path not found: ${normalized.pointer || "$"}`;
      if (status) status.textContent = message;
      return { ok: false, pointer: normalized.pointer, error: message };
    }
    row.classList.add("presentation-json-highlight");
    row.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    if (status) status.textContent = `Highlighted ${normalized.pointer || "$"}.`;
    return { ok: true, pointer: normalized.pointer };
  };

  const finalizeClose = () => {
    const dialog = lookup("presentation-json-dialog");
    if (dialog) dialog.setAttribute("aria-hidden", "true");
    body.removeAttribute("data-presentation-json-open");
    clearHighlight();
    const trigger = activeTrigger;
    activeSnapshot = null;
    activeTrigger = null;
    if (trigger && trigger.isConnected !== false && typeof trigger.focus === "function") {
      trigger.focus({ preventScroll: true });
    }
  };

  const close = () => {
    const dialog = lookup("presentation-json-dialog");
    if (!dialog || !dialog.open) return false;
    dialog.close();
    return true;
  };

  const open = (previewId, trigger = null) => {
    const snapshot = snapshots.get(previewId);
    const dialog = lookup("presentation-json-dialog");
    if (!snapshot || !dialog || typeof dialog.showModal !== "function") return false;
    activeSnapshot = snapshot;
    activeTrigger = trigger || lookup(`btn-open-${previewId}`) || null;
    const title = lookup("presentation-json-title");
    const source = lookup("presentation-json-source");
    const freshness = lookup("presentation-json-freshness");
    const redaction = lookup("presentation-json-redaction");
    const pathInput = lookup("presentation-json-path");
    const pathStatus = lookup("presentation-json-path-status");
    if (title) title.textContent = snapshot.source.label;
    if (source) {
      source.textContent = [snapshot.source.method, snapshot.source.path, snapshot.source.status, snapshot.source.schema]
        .filter(Boolean)
        .join(" · ") || "Authoritative application data";
    }
    if (freshness) freshness.textContent = snapshot.source.freshness;
    if (redaction) {
      redaction.textContent = snapshot.redacted
        ? `redacted · ${snapshot.redactedPaths.length} protected field${snapshot.redactedPaths.length === 1 ? "" : "s"}`
        : "redacted · no protected fields present";
      redaction.setAttribute("data-redacted", String(snapshot.redacted));
    }
    if (pathInput) pathInput.value = "";
    if (pathStatus) pathStatus.textContent = "Enter a JSON Pointer or dot path to highlight a field.";
    renderModalValue(snapshot.value);
    dialog.removeAttribute("aria-hidden");
    dialog.showModal();
    body.setAttribute("data-presentation-json-open", "true");
    const closeButton = lookup("btn-presentation-json-close");
    if (closeButton && typeof closeButton.focus === "function") closeButton.focus({ preventScroll: true });
    return true;
  };

  const present = (previewId, value, source = {}) => {
    const preview = lookup(previewId);
    const trigger = documentTarget.querySelector(`[data-presentation-source="${previewId}"]`);
    const normalizedSource = presentationSource({ id: previewId, ...source });
    const redaction = redactPresentationValue(value, { sourceKind: normalizedSource.sourceKind });
    const snapshot = deepFreeze({
      previewId,
      source: normalizedSource,
      value: redaction.value,
      redacted: redaction.redacted,
      redactedPaths: redaction.redactedPaths,
    });
    snapshots.set(previewId, snapshot);
    if (preview) {
      preview.textContent = previewText(snapshot);
      preview.setAttribute("data-presentation-ready", "true");
      preview.setAttribute("data-presentation-redacted", String(snapshot.redacted));
    }
    if (trigger) trigger.disabled = false;
    return snapshot;
  };

  const clear = (previewId, message = "No current JSON snapshot is available.") => {
    snapshots.delete(previewId);
    const preview = lookup(previewId);
    const trigger = documentTarget.querySelector(`[data-presentation-source="${previewId}"]`);
    if (preview) {
      preview.textContent = message;
      preview.removeAttribute("data-presentation-ready");
      preview.removeAttribute("data-presentation-redacted");
    }
    if (trigger) trigger.disabled = true;
  };

  const mount = () => {
    if (mounted) return;
    mounted = true;
    documentTarget.querySelectorAll("[data-presentation-source]").forEach((button) => {
      on(button, "click", () => open(button.getAttribute("data-presentation-source"), button));
    });
    const dialog = lookup("presentation-json-dialog");
    const closeButton = lookup("btn-presentation-json-close");
    const pathButton = lookup("btn-presentation-json-highlight");
    const pathInput = lookup("presentation-json-path");
    on(closeButton, "click", close);
    on(pathButton, "click", () => highlight(pathInput ? pathInput.value : ""));
    on(pathInput, "keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      highlight(pathInput.value);
    });
    on(dialog, "cancel", (event) => {
      event.preventDefault();
      close();
    });
    on(dialog, "click", (event) => {
      if (event.target === dialog) close();
    });
    on(dialog, "close", finalizeClose);
  };

  const debug = () => ({
    mounted,
    open: !!(lookup("presentation-json-dialog") && lookup("presentation-json-dialog").open),
    previewIds: [...snapshots.keys()],
    activePreviewId: activeSnapshot ? activeSnapshot.previewId : null,
    activeSourceId: activeSnapshot ? activeSnapshot.source.id : null,
    redacted: activeSnapshot ? activeSnapshot.redacted : null,
  });

  const dispose = () => {
    close();
    while (listeners.length) {
      const remove = listeners.pop();
      try { remove(); } catch {}
    }
    snapshots.clear();
    mounted = false;
  };

  return {
    mount,
    present,
    clear,
    open,
    close,
    highlight,
    previewSnapshot: (previewId) => snapshots.get(previewId) || null,
    activeSnapshot: () => activeSnapshot,
    debug,
    dispose,
  };
}
