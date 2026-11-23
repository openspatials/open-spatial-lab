// web/wow-extension-glance.mjs
//
// Glances: what a visitor sees of a world's extensions before choosing to engage (quiet discovery). Each extension the
// mount pass did not refuse at world load (web/wow-extension-mount.mjs, records with `selectable`) shows one glance:
// two short lines, an icon, an action word and, when given, opening hours the host words itself ("until 21:00"). A
// declaration without a glance gets one from the host: the node label, then "Extension".
//
// Selecting a glance (a click, a tap, or Enter or Space on the focused button, which the browser turns into a click)
// calls mounted.select(record), which starts that one extension. Hover, pointer movement, focus, gaze and time in view
// start nothing and send nothing anywhere: the list has no listener for them, and it logs nothing.
//
// A glance has no rank, priority or order member (the schema refuses one); the host orders glances itself, nearest to
// the viewer first. MAX_GLANCES is the one host limit on how many show.
//
// Every piece of extension-supplied text is inserted with textContent, never as markup. The DOM builder takes an
// injected document. The ordering and the wording are PURE.
import { PANEL_STYLE, panelElement as el } from "./wow-extension-consent.mjs";

/** How many glances show at once. No number is fixed yet; fewer is better, and this one constant changes it. */
export const MAX_GLANCES = Number.POSITIVE_INFINITY;
/** The icons the host draws (24-unit stroke paths). A name not listed shows DEFAULT_GLANCE_ICON. */
export const GLANCE_ICONS = Object.freeze({
  extension: "M9 4h6v4h4v6h-4v6H9v-6H5V8h4z",
  shop: "M5 8h14l-1 12H6L5 8zm4 0V6a3 3 0 0 1 6 0v2",
  food: "M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 2-2 6 0 8v10",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-10v6m0-9v.5",
  ticket: "M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z",
  music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zm0 0v14m6-12v14",
});
export const DEFAULT_GLANCE_ICON = "extension";
const HOST_LINE_LIMIT = 40;

/** The glance a record shows: its declaration's glance, or the host's (node label, "Extension"). */
export function glanceOf(record) {
  const effective = record && record.validation && record.validation.ok ? record.validation.effective : null;
  if (effective && effective.glance) return { ...effective.glance, host_made: false };
  const label = [...String((record && record.label) || "Extension")].slice(0, HOST_LINE_LIMIT).join("");
  return { line1: label, line2: "Extension", icon: DEFAULT_GLANCE_ICON, action: "Open", host_made: true };
}

const minutesOf = (time) => {
  const [hours, minutes] = String(time).split(":").map(Number);
  return hours * 60 + minutes;
};
/** The host's wording of glance hours { opens, closes } at `now`: "until 21:00" while open, "opens 09:00" otherwise. */
export function hoursLine(hours, now = new Date()) {
  if (!hours) return "";
  const at = now.getHours() * 60 + now.getMinutes(), opens = minutesOf(hours.opens), closes = minutesOf(hours.closes);
  const open = opens <= closes ? at >= opens && at < closes : at >= opens || at < closes;
  return open ? `until ${hours.closes}` : `opens ${hours.opens}`;
}

/** The world position of the node that carries a record ([x, y, z]), read from its group's world matrix. */
export function positionOf(record) {
  const group = record && record.group;
  if (!group) return [0, 0, 0];
  if (typeof group.updateWorldMatrix === "function") group.updateWorldMatrix(true, false);
  const elements = group.matrixWorld && group.matrixWorld.elements;
  return elements ? [elements[12], elements[13], elements[14]] : [0, 0, 0];
}

/**
 * orderGlances(items, viewer) -> a new array of items ({ position: [x, y, z], ... }) nearest to `viewer` ([x, y, z];
 * the origin when absent) first. Equal distances keep their order. The declarations' file order is never the rule.
 */
export function orderGlances(items, viewer) {
  const from = Array.isArray(viewer) && viewer.length === 3 ? viewer.map(Number) : [0, 0, 0];
  const distance = (item) => Math.hypot(item.position[0] - from[0], item.position[1] - from[1], item.position[2] - from[2]);
  return items.map((item, at) => ({ item, at, distance: distance(item) }))
    .sort((a, b) => a.distance - b.distance || a.at - b.at)
    .map(({ item }) => item);
}

/** The glances of one mount pass, nearest first: [{ key, record, glance, position }]. */
export function glancesOf(mounted, viewer = null, limit = MAX_GLANCES) {
  const records = mounted && Array.isArray(mounted.records) ? mounted.records.filter((record) => record.selectable) : [];
  const items = records.map((record) => ({ key: `${record.label}#${record.index}`, record, glance: glanceOf(record), position: positionOf(record) }));
  return orderGlances(items, viewer).slice(0, Math.max(0, limit));
}

const SVG = "http://www.w3.org/2000/svg";
function iconElement(doc, name) {
  const known = Object.hasOwn(GLANCE_ICONS, name) ? name : DEFAULT_GLANCE_ICON;
  const holder = el(doc, "span", { style: "flex:none;display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;border-radius:8px;background:rgba(126,224,168,0.14);color:#7ee0a8;", attrs: { class: "ue-glance-icon", "data-ue-icon": known, "aria-hidden": "true" } });
  if (typeof doc.createElementNS !== "function") return holder;
  const svg = doc.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", focusable: "false" })) svg.setAttribute(name, value);
  const path = doc.createElementNS(SVG, "path");
  path.setAttribute("d", GLANCE_ICONS[known]);
  svg.append(path);
  holder.append(svg);
  return holder;
}

/**
 * renderGlanceList({ document, mounted, viewer, limit, refreshMs, now }) -> { element, refresh(), dispose() }: one
 * button per glance, nearest first. `viewer` () -> [x, y, z] gives the viewer's position; with one, the order is
 * checked again every `refreshMs` (default 1000). A click on a glance calls mounted.select(record). The list follows
 * the mount pass's changes (mounted.subscribe): each glance shows its extension's state once it is no longer
 * "not started".
 */
export function renderGlanceList({ document: doc, mounted, viewer = null, limit = MAX_GLANCES, refreshMs = 1000, now = () => new Date() }) {
  const element = el(doc, "section", {
    style: "position:fixed;z-index:58;left:16px;bottom:96px;display:grid;gap:8px;width:min(320px,calc(100vw - 32px));max-height:calc(100vh - 200px);overflow:auto;",
    attrs: { "aria-label": "Nearby extensions", "data-testid": "ue-glances" },
  });
  const buttons = new Map();

  function buttonOf(item) {
    const { record, glance } = item;
    const hours = glance.hours ? hoursLine(glance.hours, now()) : "";
    const state = el(doc, "span", { style: `${PANEL_STYLE.mono}flex:none;color:#7ee0a8;`, text: glance.action, attrs: { class: "ue-glance-action" } });
    const button = el(doc, "button", {
      style: `${PANEL_STYLE.surface}display:flex;gap:10px;align-items:center;width:100%;padding:8px 10px;text-align:left;cursor:pointer;`,
      attrs: { type: "button", "data-testid": "ue-glance", "data-ue-glance": item.key, "data-ue-glance-state": "not started" },
    }, [
      iconElement(doc, glance.icon),
      el(doc, "span", { style: "display:grid;min-width:0;flex:1;" }, [
        el(doc, "span", { style: "font-weight:600;overflow-wrap:anywhere;", text: glance.line1, attrs: { class: "ue-glance-line1" } }),
        el(doc, "span", { style: `${PANEL_STYLE.dim}overflow-wrap:anywhere;`, text: glance.line2, attrs: { class: "ue-glance-line2" } }),
        hours ? el(doc, "span", { style: `${PANEL_STYLE.dim}font-size:12px;`, text: hours, attrs: { class: "ue-glance-hours" } }) : null,
      ]),
      state,
    ]);
    button.addEventListener("click", () => { void mounted.select(record); });
    return { button, state, action: glance.action };
  }

  function refresh() {
    const items = glancesOf(mounted, typeof viewer === "function" ? viewer() : null, limit);
    const order = [];
    for (const item of items) {
      if (!buttons.has(item.record)) buttons.set(item.record, buttonOf(item));
      const shown = buttons.get(item.record);
      const status = typeof mounted.stateOf === "function" ? mounted.stateOf(item.record) : item.record.status;
      const words = status === "not started" ? shown.action : status === "refused" || status === "failed" ? `${status} at ${item.record.stage}` : status;
      shown.button.setAttribute("data-ue-glance-state", status);
      if (shown.state.textContent !== words) shown.state.textContent = words;
      order.push(shown.button);
    }
    const current = [...element.children];
    if (current.length !== order.length || current.some((child, at) => child !== order[at])) element.replaceChildren(...order);
  }

  const unsubscribe = mounted && typeof mounted.subscribe === "function" ? mounted.subscribe(refresh) : null;
  const timer = typeof viewer === "function" && refreshMs > 0 ? setInterval(refresh, refreshMs) : null;
  refresh();
  return {
    element,
    refresh,
    dispose() {
      if (unsubscribe) unsubscribe();
      if (timer) clearInterval(timer);
      element.remove();
    },
  };
}

export default { renderGlanceList, glancesOf, glanceOf, orderGlances, hoursLine, positionOf, MAX_GLANCES, GLANCE_ICONS };
