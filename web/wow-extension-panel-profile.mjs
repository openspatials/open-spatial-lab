// web/wow-extension-panel-profile.mjs
//
// The panel profile: the safe subset of HTML and CSS an extension's panel document may use, and the page-side limits on
// it. This file is the one source of these lists; the filter (web/wow-extension-panel-filter.mjs) and the panel on the
// page (web/wow-extension-panel.mjs) read them from here. Everything not listed is refused: the lists name what is
// allowed, never what is not.
//
// The rate of panel-set calls is a budget of the host interface and lives with it (runtime/extension-host/bindings/
// ue-core.mjs, PANEL_SETS_PER_SECOND), where the call is answered.

/** The panel sizes in CSS pixels. One panel shows at a time per page. The glance is not a document and has no size here. */
export const PANEL_SIZES = Object.freeze({
  card: Object.freeze({ width: 320, height: 200 }),
  full: Object.freeze({ width: 640, height: 480 }),
});

/** Elements a panel document may hold. `style` may appear once. */
export const PANEL_ELEMENTS = Object.freeze([
  "div", "span", "p", "h1", "h2", "h3", "strong", "em", "br", "ul", "ol", "li", "img", "button", "label", "input", "progress", "style",
]);
/** Wrappers the HTML parser makes or a document may write: accepted and dropped (their children are kept). */
export const PANEL_WRAPPERS = Object.freeze(["html", "head", "body"]);
/** The types an `input` may have; an input without a type is a text field. */
export const PANEL_INPUT_TYPES = Object.freeze(["text", "checkbox", "range", "button"]);
/** The types a `button` may have. */
export const PANEL_BUTTON_TYPES = Object.freeze(["button"]);
/** How many text fields one document may hold. */
export const PANEL_TEXT_FIELDS = 1;

/** Attributes, each with the elements that may carry it (null: any allowed element). */
export const PANEL_ATTRIBUTES = Object.freeze({
  id: null,
  class: null,
  style: null,
  "aria-label": null,
  alt: Object.freeze(["img"]),
  src: Object.freeze(["img"]),
  type: Object.freeze(["input", "button"]),
  value: Object.freeze(["input", "progress"]),
  min: Object.freeze(["input"]),
  max: Object.freeze(["input", "progress"]),
  step: Object.freeze(["input"]),
  checked: Object.freeze(["input"]),
  disabled: Object.freeze(["input", "button"]),
  placeholder: Object.freeze(["input"]),
  for: Object.freeze(["label"]),
});

/** Images: a data: URL of one of these types, base64, at most PANEL_IMAGE_BYTES decoded. No other address form. */
export const PANEL_IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
export const PANEL_IMAGE_BYTES = 256 * 1024;

/**
 * Style properties. A list names the keywords the property may take; null means any value the value rules allow
 * (lengths in PANEL_LENGTH_UNITS, numbers, colours through PANEL_VALUE_FUNCTIONS, keywords).
 */
export const PANEL_STYLE_PROPERTIES = Object.freeze({
  display: Object.freeze(["block", "inline", "inline-block", "flex", "none"]),
  "flex-direction": Object.freeze(["row", "row-reverse", "column", "column-reverse"]),
  "flex-grow": null,
  "flex-wrap": Object.freeze(["nowrap", "wrap", "wrap-reverse"]),
  "align-items": Object.freeze(["normal", "stretch", "center", "start", "end", "flex-start", "flex-end", "baseline"]),
  "justify-content": Object.freeze(["normal", "center", "start", "end", "flex-start", "flex-end", "space-between", "space-around", "space-evenly", "stretch"]),
  gap: null,
  position: Object.freeze(["static", "relative", "absolute"]),
  top: null, left: null, right: null, bottom: null,
  width: null, height: null, "min-width": null, "min-height": null, "max-width": null, "max-height": null,
  margin: null,
  padding: null,
  "box-sizing": Object.freeze(["content-box", "border-box"]),
  overflow: Object.freeze(["visible", "hidden"]),
  color: null,
  "background-color": null,
  "border-color": null,
  "border-width": null,
  "border-style": Object.freeze(["none", "hidden", "solid", "dashed", "dotted", "double"]),
  "border-radius": null,
  opacity: null,
  "font-family": null,
  "font-size": null,
  "font-weight": null,
  "font-style": Object.freeze(["normal", "italic", "oblique"]),
  "line-height": null,
  "text-align": Object.freeze(["left", "right", "center", "justify", "start", "end"]),
});
/** The longhands a browser's style parser gives for each allowed shorthand; each is checked as its shorthand. */
const SIDES = ["top", "right", "bottom", "left"];
const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];
export const PANEL_PROPERTY_LONGHANDS = Object.freeze({
  margin: Object.freeze(SIDES.map((side) => `margin-${side}`)),
  padding: Object.freeze(SIDES.map((side) => `padding-${side}`)),
  gap: Object.freeze(["row-gap", "column-gap"]),
  overflow: Object.freeze(["overflow-x", "overflow-y"]),
  "border-color": Object.freeze(SIDES.map((side) => `border-${side}-color`)),
  "border-width": Object.freeze(SIDES.map((side) => `border-${side}-width`)),
  "border-style": Object.freeze(SIDES.map((side) => `border-${side}-style`)),
  "border-radius": Object.freeze(CORNERS.map((corner) => `border-${corner}-radius`)),
});
/** Keywords every property may take, beside its own. */
export const PANEL_WIDE_KEYWORDS = Object.freeze(["inherit", "initial", "unset"]);
/** The font families a panel may name: the host's own, no others. */
export const PANEL_HOST_FONTS = Object.freeze(["Inter", "system-ui", "ui-sans-serif", "ui-monospace", "sans-serif", "serif", "monospace"]);
/** Units a length may have. */
export const PANEL_LENGTH_UNITS = Object.freeze(["px", "%", "em", "rem"]);
/** The only functions a style value may call. */
export const PANEL_VALUE_FUNCTIONS = Object.freeze(["rgb", "rgba", "hsl", "hsla"]);
/** The pseudo-classes a selector may use; no pseudo-element and no attribute selector. */
export const PANEL_PSEUDO_CLASSES = Object.freeze(["disabled", "checked"]);

/** A document is at most this many UTF-8 bytes, elements and levels deep. */
export const PANEL_DOCUMENT_BYTES = 64 * 1024;
export const PANEL_MAX_ELEMENTS = 400;
export const PANEL_MAX_DEPTH = 16;

/** The content policy of the frame a panel lives in: nothing loads but data: images and inline styles. */
export const PANEL_FRAME_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

export default { PANEL_SIZES, PANEL_ELEMENTS, PANEL_ATTRIBUTES, PANEL_STYLE_PROPERTIES, PANEL_DOCUMENT_BYTES, PANEL_MAX_ELEMENTS, PANEL_MAX_DEPTH };
