// web/wow-extension-panel.mjs
//
// Extension panels on the page: the card (320 x 200) and the full panel (640 x 480) an extension describes in the safe
// HTML and CSS subset (web/wow-extension-panel-profile.mjs) through ui.panel-set, drawn in the Interface, inside a host
// frame. The glance stays as it is (web/wow-extension-glance.mjs); it is signed data, not a document.
//
// Two parts:
//   - createPanelBoard(): the panels of a page, PURE of the DOM. Each started extension is one entry, with the
//     attachment that owns it. A panel-set from the extension (the host's `panel` hook) is filtered at once; a refused
//     document is not kept and its reason is logged on the entry (the Extensions panel shows it). One panel shows at a
//     time: the card of the extension the visitor selected, or, after a click inside that card, its full panel. A full
//     document sent before any click is kept and not shown. Events from the panel's controls go to the owning
//     attachment only, as Notify { type: "panel", attachment, size, id, event: "click" | "change", value? }.
//   - renderPanelHost(): the host frame around the panel, outside the document's reach: the extension's label, a back
//     control (full to card), a question mark (the Extensions panel at that extension) and a close control. The
//     panel itself is built from the filter's description inside a frame with no scripts (sandbox="allow-same-origin",
//     no allow-scripts) whose content policy loads nothing but data: images and inline styles. Text is set as text and
//     styles property by property through the style object. The host listens for clicks from outside the frame: the
//     frame takes no pointer input, and the host finds the control under a click and acts for it (a button or an
//     input of type button sends click; a checkbox toggles and a range takes the value under the click, each sending
//     change; the one text field takes focus and sends change once it loses it). No hover, focus, scroll or
//     time-in-view event exists.
import { filterPanelDocument } from "./wow-extension-panel-filter.mjs";
import { PANEL_FRAME_POLICY, PANEL_SIZES } from "./wow-extension-panel-profile.mjs";
import { isRml, rmlToPanelDocument } from "./wow-extension-rml.mjs";
import { PANEL_STYLE, panelElement as el } from "./wow-extension-consent.mjs";

/** How many log lines an entry keeps. */
const KEPT_LOG = 20;

/** The filter of one page: RML is turned into a panel document first, then every document is filtered. */
export function createPanelFilter(win) {
  return (text) => filterPanelDocument(isRml(text) ? rmlToPanelDocument(text) : text, win);
}

/**
 * createPanelBoard({ filter }) -> the panels of one page. `filter(text)` -> { ok, parts | reason } (createPanelFilter);
 * without one every document is refused.
 *   add(key, { label, extension, attachment })   an extension that may send panels; again to set its extension
 *   receive(key, event)                          the host's panel hook: { kind: "panel-set", size, document } or
 *                                                { kind: "panel-close", size }
 *   select(key)  the visitor selected this extension   click(key)  a click inside its card   back(key)   dismiss()
 *   current() -> { key, label, size, parts } | null    send(key, { size, id, event, value }) -> true when delivered
 *   logOf(key) -> [line]    remove(key)    clear()    subscribe(listener) -> unsubscribe
 */
export function createPanelBoard({ filter = null } = {}) {
  const entries = new Map();
  const listeners = new Set();
  let selected = null;
  const changed = () => { for (const listener of [...listeners]) { try { listener(); } catch {} } };
  const entryOf = (key) => {
    if (!entries.has(key)) entries.set(key, { key, label: String(key), extension: null, attachment: null, panels: {}, log: [], view: "card", unlocked: false });
    return entries.get(key);
  };
  const note = (entry, line) => {
    entry.log.push(line);
    if (entry.log.length > KEPT_LOG) entry.log.shift();
  };

  return {
    add(key, { label, extension = null, attachment = null } = {}) {
      const entry = entryOf(key);
      if (label !== undefined) entry.label = String(label);
      entry.extension = extension;
      entry.attachment = attachment;
      changed();
    },
    receive(key, event) {
      if (!event || !Object.hasOwn(PANEL_SIZES, event.size)) return;
      const entry = entryOf(key);
      if (event.kind === "panel-close") {
        delete entry.panels[event.size];
        if (event.size === "full") entry.view = "card";
      } else if (event.kind === "panel-set") {
        const result = typeof filter === "function" ? filter(event.document) : { ok: false, reason: "this page has no panel filter" };
        if (result.ok) {
          entry.panels[event.size] = { parts: result.parts };
          if (event.size === "full" && entry.unlocked) entry.view = "full";
        } else {
          delete entry.panels[event.size];
          note(entry, `${event.size} panel refused: ${result.reason}`);
        }
      } else return;
      changed();
    },
    select(key) {
      selected = key;
      entryOf(key);
      changed();
    },
    click(key) {
      const entry = entries.get(key);
      if (!entry || entry.view === "full") return;
      entry.unlocked = true;
      if (entry.panels.full) entry.view = "full";
      changed();
    },
    back(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.view = "card";
      entry.unlocked = false;
      changed();
    },
    dismiss() {
      selected = null;
      changed();
    },
    current() {
      const entry = selected === null ? null : entries.get(selected);
      if (!entry) return null;
      const size = entry.view === "full" && entry.panels.full ? "full" : entry.panels.card ? "card" : null;
      return size ? { key: entry.key, label: entry.label, size, parts: entry.panels[size].parts } : null;
    },
    send(key, { size, id, event, value }) {
      const entry = entries.get(key);
      if (!entry) return false;
      const targets = [entry];
      let sent = false;
      for (const target of targets) {
        if (!target.extension || typeof target.extension.notify !== "function" || target.attachment === null) continue;
        void target.extension.notify(target.attachment, { type: "panel", attachment: target.attachment, size, id, event, ...(value === undefined ? {} : { value }) });
        sent = true;
      }
      return sent;
    },
    logOf: (key) => (entries.has(key) ? [...entries.get(key).log] : []),
    get selected() { return selected; },
    remove(key) {
      entries.delete(key);
      if (selected === key) selected = null;
      changed();
    },
    clear() {
      entries.clear();
      selected = null;
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ---- The host frame (DOM, injected document) ----

const FRAME_BASE = "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}"
  + "body{font:14px/1.4 Inter,system-ui,sans-serif;color:#e9eef6;background:rgba(14,18,28,0.96);box-sizing:border-box;}";
const FRAME_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PANEL_FRAME_POLICY}"><style>${FRAME_BASE}</style></head><body></body></html>`;

/** Builds the filter's description into `target` ({ doc, root, head }): a style block set rule by rule, then the tree. */
function buildPanel(target, parts) {
  const { doc, root, head } = target;
  const style = doc.createElement("style");
  style.setAttribute("data-ue-panel-style", "");
  head.append(style);
  const sheet = style.sheet;
  for (const rule of parts.rules) {
    if (!sheet) break;
    const index = sheet.insertRule(`${rule.selector} {}`, sheet.cssRules.length);
    for (const [name, value, priority] of rule.declarations) sheet.cssRules[index].style.setProperty(name, value, priority);
  }
  const make = (node) => {
    if (Object.hasOwn(node, "text")) return doc.createTextNode(node.text);
    const element = doc.createElement(node.tag);
    for (const [name, value] of node.attrs) element.setAttribute(name, value);
    for (const [name, value, priority] of node.style) element.style.setProperty(name, value, priority);
    for (const child of node.children) element.append(make(child));
    return element;
  };
  for (const node of parts.tree) root.append(make(node));
}

/**
 * renderPanelHost({ document, board, onHelp }) -> { element, refresh(), shown(), dispose() }: the one panel of a page
 * in its host frame, following the board. `onHelp(key)` opens the Extensions panel at that extension. shown() -> the
 * panel on screen { key, size } or null; ready() resolves once the frame shows what the board holds.
 */
export function renderPanelHost({ document: doc, board, onHelp = null }) {
  const element = el(doc, "section", {
    style: `position:fixed;z-index:57;right:16px;bottom:96px;display:none;padding:8px;${PANEL_STYLE.surface}`,
    attrs: { role: "region", "aria-label": "Extension panel", "data-testid": "ue-panel-host" },
  });
  const label = el(doc, "span", { style: "font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", attrs: { "data-testid": "ue-panel-label" } });
  const button = (text, action, aria) => el(doc, "button", { style: `${PANEL_STYLE.button}padding:2px 8px;`, text, attrs: { type: "button", "data-ue-panel-action": action, "aria-label": aria } });
  const back = button("Back", "back", "Back to the card");
  const help = button("?", "help", "About this extension");
  const close = button("×", "close", "Close the panel");
  const header = el(doc, "div", { style: "display:flex;gap:6px;align-items:center;margin:0 0 6px;" }, [label, back, help, close]);
  const box = el(doc, "div", { attrs: { "data-testid": "ue-panel-box" } });
  const frame = doc.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("title", "Extension panel");
  frame.setAttribute("data-testid", "ue-panel-frame");
  frame.setAttribute("style", "display:block;border:0;border-radius:8px;pointer-events:none;");
  box.append(frame);
  element.append(header, box);

  let shown = null;
  let frameDoc = null;
  let disposed = false;
  let pending = Promise.resolve();
  const loaded = new Promise((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
  frame.setAttribute("srcdoc", FRAME_DOCUMENT);

  // Clicks and changes, heard from outside the frame. The frame takes no pointer input (pointer-events: none), so a
  // click lands on the host's box; the host finds the control under it in the frame's document and acts for it. No
  // listener runs on the frame's document: a browser may run none on a document whose frame has no scripts.
  const send = (control, event, value) => {
    if (shown && control.id) board.send(shown.key, { size: shown.size, id: control.id, event, ...(value === undefined ? {} : { value }) });
  };
  let watched = null;
  // The one text field: focused by the host; its value is read while it has focus and sent once when it loses it.
  function watchText(input) {
    if (watched) return;
    const before = input.value;
    watched = setInterval(() => {
      if (disposed || !frameDoc || frameDoc.activeElement === input) return;
      clearInterval(watched);
      watched = null;
      if (input.value !== before) send(input, "change", input.value);
    }, 250);
  }
  function actOn(control, x) {
    if (control.disabled) return;
    if (control.localName === "button") return send(control, "click");
    const type = (control.getAttribute("type") || "text").toLowerCase();
    if (type === "button") return send(control, "click");
    if (type === "checkbox") {
      control.checked = !control.checked;
      return send(control, "change", control.checked);
    }
    if (type === "range") {
      const box = control.getBoundingClientRect();
      const min = Number(control.min || 0), max = Number(control.max || 100);
      const ratio = box.width > 0 ? Math.min(1, Math.max(0, (x - box.left) / box.width)) : 0;
      const before = control.value;
      control.value = String(min + ratio * (max - min));
      if (control.value !== before) send(control, "change", control.value);
      return undefined;
    }
    control.focus();
    watchText(control);
    return undefined;
  }
  function onClick(event) {
    if (!shown || !frameDoc) return;
    const rect = frame.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return;
    const { key, size } = shown;
    const hit = frameDoc.elementFromPoint(x, y);
    let control = hit && typeof hit.closest === "function" ? hit.closest("button, input, label") : null;
    if (control && control.localName === "label") control = control.control || null;
    if (control) actOn(control, x);
    if (size === "card") board.click(key);
  }
  box.addEventListener("click", onClick);
  const frameTarget = () => ({ doc: frameDoc, root: frameDoc.body, head: frameDoc.head });

  async function show(current) {
    await loaded;
    if (disposed) return;
    if (!frameDoc) frameDoc = frame.contentDocument;
    if (!current) {
      shown = null;
      element.style.display = "none";
      return;
    }
    if (shown && shown.parts === current.parts) return;
    const { width, height } = PANEL_SIZES[current.size];
    frame.setAttribute("width", String(width));
    frame.setAttribute("height", String(height));
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    for (const old of frameDoc.querySelectorAll("[data-ue-panel-style]")) old.remove();
    frameDoc.body.replaceChildren();
    const target = frameTarget();
    buildPanel(target, current.parts);
    label.textContent = current.label;
    back.style.display = current.size === "full" ? "" : "none";
    element.setAttribute("data-ue-panel", current.key);
    element.setAttribute("data-ue-panel-size", current.size);
    element.style.display = "block";
    shown = { key: current.key, size: current.size, parts: current.parts };
  }
  function refresh() {
    const current = board.current();
    pending = pending.then(() => show(current)).catch(() => {});
    return pending;
  }

  back.addEventListener("click", () => { if (shown) board.back(shown.key); });
  help.addEventListener("click", () => { if (shown && typeof onHelp === "function") onHelp(shown.key); });
  close.addEventListener("click", () => board.dismiss());
  const unsubscribe = board.subscribe(refresh);
  refresh();
  return {
    element,
    refresh,
    ready: () => pending,
    shown: () => (shown ? { key: shown.key, size: shown.size } : null),
    frame,
    dispose() {
      disposed = true;
      unsubscribe();
      if (watched) clearInterval(watched);
      box.removeEventListener("click", onClick);
      element.remove();
    },
  };
}

export default { createPanelBoard, createPanelFilter, renderPanelHost };
